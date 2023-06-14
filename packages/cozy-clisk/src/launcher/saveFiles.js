import Minilog from '@cozy/minilog'
import get from 'lodash/get'
import omit from 'lodash/omit'
import { Q } from 'cozy-client'
import retry from 'bluebird-retry'

const log = Minilog('saveFiles')

const saveFiles = async (client, entries, folderPath, options = {}) => {
  if (!entries) {
    throw new Error('Savefiles : No list of files given')
  }
  if (entries.length === 0) {
    log.warn('No file to download')
  }
  if (!options.manifest) {
    throw new Error('Savefiles : no manifest')
  }
  if (!options.sourceAccount) {
    throw new Error('Savefiles : no sourceAccount')
  }
  if (!options.sourceAccountIdentifier) {
    throw new Error('Savefiles : no sourceAccountIdentifier')
  }
  if (!client) {
    throw new Error('Savefiles : No cozy-client instance given')
  }

  if (!options.fileIdAttributes) {
    throw new Error('Savefiles : No fileIdAttributes')
  }

  const saveOptions = {
    folderPath,
    subPath: options.subPath,
    fileIdAttributes: options.fileIdAttributes,
    manifest: options.manifest,
    postProcess: options.postProcess,
    contentType: options.contentType,
    shouldReplaceFile: options.shouldReplaceFile,
    validateFile: options.validateFile || defaultValidateFile,
    sourceAccountOptions: {
      sourceAccount: options.sourceAccount,
      sourceAccountIdentifier: options.sourceAccountIdentifier
    }
  }

  if (options.validateFileContent) {
    if (options.validateFileContent === true) {
      saveOptions.validateFileContent = defaultValidateFileContent
    } else if (typeof options.validateFileContent === 'function') {
      saveOptions.validateFileContent = options.validateFileContent
    }
  }

  noMetadataDeduplicationErrors(saveOptions)

  const canBeSaved = entry => entry.filestream

  let savedFiles = 0
  const savedEntries = []
  for (let entry of entries) {
    ;['filename', 'shouldReplaceName'].forEach(key =>
      addValOrFnResult(entry, key, options)
    )
    if (entry.filestream && !entry.filename) {
      log.warn(
        'Missing filename property for for filestream entry, entry is ignored'
      )
      return
    }
    if (canBeSaved(entry)) {
      const folderPath = await getOrCreateDestinationPath(
        client,
        entry,
        saveOptions
      )
      entry = await saveEntry(client, entry, {
        ...saveOptions,
        folderPath
      })
      if (entry && entry._cozy_file_to_create) {
        savedFiles++
        delete entry._cozy_file_to_create
      }
    }
    savedEntries.push(entry)
  }

  log.debug(
    `Created ${savedFiles} files for ${
      savedEntries ? savedEntries.length : 'n'
    } entries`
  )
  return savedEntries
}

const saveEntry = async function (client, entry, options) {
  let file = await getFileIfExists(client, entry, options)
  let shouldReplace = false
  if (file) {
    try {
      shouldReplace = await shouldReplaceFile(file, entry, options)
    } catch (err) {
      log.warn(`Error in shouldReplaceFile : ${err.message}`)
      shouldReplace = true
    }
  }

  let method = 'create'

  if (shouldReplace && file) {
    method = 'updateById'
    log.debug(`Will replace ${getFilePath({ options, file })}...`)
  }

  try {
    if (!file || method === 'updateById') {
      log.debug(omit(entry, 'filestream'))
      logFileStream(entry.filestream)
      log.debug(
        `File ${getFilePath({
          options,
          entry
        })} does not exist yet or is not valid`
      )
      entry._cozy_file_to_create = true
      file = await retry(createFile, {
        interval: 1000,
        throw_original: true,
        max_tries: options.retry,
        args: [client, entry, options, method, file ? file : undefined]
      }).catch(err => {
        if (err.message === 'BAD_DOWNLOADED_FILE') {
          log.warn(
            `Could not download file after ${options.retry} tries removing the file`
          )
        } else {
          log.warn('unknown file download error: ' + err.message)
          log.warn(err)
        }
      })
    }

    attachFileToEntry(entry, file)

    sanitizeEntry(entry)
    if (options.postProcess) {
      await options.postProcess(entry)
    }
  } catch (err) {
    if (getErrorStatus(err) === 413) {
      // the cozy quota is full
      throw new Error('DISK_QUOTA_EXCEEDED')
    }
    log.warn('SAVE_FILE_FAILED')
    log.warn(err.message)
    log.warn(
      `Error caught while trying to save the file ${
        entry.fileurl ? entry.fileurl : entry.filename
      }`
    )
  }
  return entry
}

function noMetadataDeduplicationErrors(options) {
  const fileIdAttributes = options.fileIdAttributes
  if (!fileIdAttributes) {
    throw new Error(
      'Savefiles : No deduplication key is defined, file deduplication will be based on file path'
    )
  }

  const slug = get(options, 'manifest.slug')
  if (!slug) {
    throw new Error('Savefiles : No slug is defined for the current connector')
  }
}

async function getFileIfExists(client, entry, options) {
  const fileIdAttributes = options.fileIdAttributes
  const slug = options.manifest.slug
  const sourceAccountIdentifier = get(
    options,
    'sourceAccountOptions.sourceAccountIdentifier'
  )

  const isReadyForFileMetadata =
    fileIdAttributes && slug && sourceAccountIdentifier
  if (isReadyForFileMetadata) {
    log.debug('Deduplicating file with metadata')
    const file = await getFileFromMetaData(
      client,
      entry,
      fileIdAttributes,
      sourceAccountIdentifier,
      slug
    )
    if (!file) {
      // no file with correct metadata, maybe the corresponding file already exist in the default
      // path from a previous version of the connector
      log.debug('Rolling back on detection by filename')
      return getFileFromPath(client, entry, options)
    } else {
      return file
    }
  } else {
    log.debug('Not enough metadata, deduplicating by filename')
    return getFileFromPath(client, entry, options)
  }
}

async function getFileFromMetaData(
  client,
  entry,
  fileIdAttributes,
  sourceAccountIdentifier,
  slug
) {
  log.debug(
    `Checking existence of ${calculateFileKey(entry, fileIdAttributes)}`
  )
  const files = await client.queryAll(
    Q('io.cozy.files')
      .where({
        metadata: {
          fileIdAttributes: calculateFileKey(entry, fileIdAttributes)
        },
        trashed: false,
        cozyMetadata: {
          sourceAccountIdentifier,
          createdByApp: slug
        }
      })
      .indexFields([
        'metadata.fileIdAttributes',
        'trashed',
        'cozyMetadata.sourceAccountIdentifier',
        'cozyMetadata.createdByApp'
      ])
  )

  if (files && files[0]) {
    if (files.length > 1) {
      log.warn(
        `Found ${files.length} files corresponding to ${calculateFileKey(
          entry,
          fileIdAttributes
        )}`
      )
    }
    return files[0]
  } else {
    log.debug('not found')
    return false
  }
}

async function getFileFromPath(client, entry, options) {
  const filepath = getFilePath({ entry, options })
  try {
    log.debug(`Checking existence of ${filepath}`)
    const result = await client.collection('io.cozy.files').statByPath(filepath)
    return result.data
  } catch (err) {
    log.debug(err.message)
    return false
  }
}

async function createFile(client, entry, options, method, file) {
  const folder = await client
    .collection('io.cozy.files')
    .statByPath(options.folderPath)
  let createFileOptions = {
    name: getFileName(entry),
    dirId: folder.data._id
  }
  if (options.contentType) {
    createFileOptions.contentType = options.contentType
  }
  createFileOptions = {
    ...createFileOptions,
    ...entry.fileAttributes,
    ...options.sourceAccountOptions
  }

  if (options.fileIdAttributes) {
    createFileOptions = {
      ...createFileOptions,
      ...{
        metadata: {
          ...createFileOptions.metadata,
          fileIdAttributes: calculateFileKey(entry, options.fileIdAttributes)
        }
      }
    }
  }

  const toCreate = entry.filestream

  let fileDocument
  if (method === 'create') {
    const clientResponse = await client.save({
      _type: 'io.cozy.files',
      type: 'file',
      data: toCreate,
      ...createFileOptions
    })
    fileDocument = clientResponse.data
  } else if (method === 'updateById') {
    log.debug(`replacing file for ${entry.filename}`)
    const clientResponse = client.save({
      _id: file._id,
      _rev: file._rev,
      _type: 'io.cozy.files',
      data: toCreate,
      ...createFileOptions
    })
    fileDocument = clientResponse.data
  }
  if (options.validateFile) {
    if ((await options.validateFile(fileDocument)) === false) {
      await removeFile(client, fileDocument)
      throw new Error('BAD_DOWNLOADED_FILE')
    }

    if (
      options.validateFileContent &&
      !(await options.validateFileContent(fileDocument))
    ) {
      await removeFile(client, fileDocument)
      throw new Error('BAD_DOWNLOADED_FILE')
    }
  }

  return fileDocument
}

const defaultShouldReplaceFile = (file, entry, options) => {
  const shouldForceMetadataAttr = attr => {
    const result =
      !getAttribute(file, `metadata.${attr}`) &&
      get(entry, `fileAttributes.metadata.${attr}`)
    if (result) {
      log.debug(`filereplacement: adding ${attr} metadata`)
    }
    return result
  }
  // replace all files with meta if there is file metadata to add
  const fileHasNoMetadata = !getAttribute(file, 'metadata')
  const fileHasNoId = !getAttribute(file, 'metadata.fileIdAttributes')
  const entryHasMetadata = !!get(entry, 'fileAttributes.metadata')
  const hasSourceAccountIdentifierOption = !!get(
    options,
    'sourceAccountOptions.sourceAccountIdentifier'
  )
  const fileHasSourceAccountIdentifier = !!getAttribute(
    file,
    'cozyMetadata.sourceAccountIdentifier'
  )
  const result =
    (fileHasNoMetadata && entryHasMetadata) ||
    (fileHasNoId && !!options.fileIdAttributes) ||
    (hasSourceAccountIdentifierOption && !fileHasSourceAccountIdentifier) ||
    shouldForceMetadataAttr('carbonCopy') ||
    shouldForceMetadataAttr('electronicSafe') ||
    shouldForceMetadataAttr('categories')

  if (result) {
    if (fileHasNoMetadata && entryHasMetadata) {
      log.debug('filereplacement: metadata to add')
    }
    if (fileHasNoId && !!options.fileIdAttributes) {
      log.debug('filereplacement: adding fileIdAttributes')
    }
    if (hasSourceAccountIdentifierOption && !fileHasSourceAccountIdentifier) {
      log.debug('filereplacement: adding sourceAccountIdentifier')
    }
  }

  return result
}

const shouldReplaceFile = async function (file, entry, options) {
  const isValid = !options.validateFile || (await options.validateFile(file))
  if (!isValid) {
    log.warn(`${getFileName({ file, options })} is invalid`)
    throw new Error('BAD_DOWNLOADED_FILE')
  }
  const shouldReplaceFileFn =
    entry.shouldReplaceFile ||
    options.shouldReplaceFile ||
    defaultShouldReplaceFile

  return shouldReplaceFileFn(file, entry, options)
}

const removeFile = async function (client, file) {
  if (!client) {
    log.error('No client, impossible to delete file')
  } else {
    await client.collection('io.cozy.files').deleteFilePermanently(file._id)
  }
}

module.exports = saveFiles
module.exports.getFileIfExists = getFileIfExists

function getFileName(entry) {
  let filename
  if (entry.filename) {
    filename = entry.filename
  } else {
    log.error('Could not get a file name for the entry')
    return false
  }
  return sanitizeFileName(filename)
}

function sanitizeFileName(filename) {
  return filename.replace(/^\.+$/, '').replace(/[/?<>\\:*|":]/g, '')
}

function checkFileSize(fileobject) {
  const size = getAttribute(fileobject, 'size')
  const name = getAttribute(fileobject, 'name')
  if (size === 0 || size === '0') {
    log.warn(`${name} is empty`)
    log.warn('BAD_FILE_SIZE')
    return false
  }
  return true
}

function logFileStream(fileStream) {
  if (!fileStream) {
    return
  }

  if (fileStream && fileStream.constructor && fileStream.constructor.name) {
    log.debug(
      `The fileStream attribute is an instance of ${fileStream.constructor.name}`
    )
  } else {
    log.debug(`The fileStream attribute is a ${typeof fileStream}`)
  }
}

function getErrorStatus(err) {
  try {
    return Number(JSON.parse(err.message).errors[0].status)
  } catch (e) {
    return null
  }
}

function addValOrFnResult(entry, key, options) {
  if (entry[key]) {
    entry[key] = getValOrFnResult(entry[key], entry, options)
  }
}

function getValOrFnResult(val, ...args) {
  if (typeof val === 'function') {
    return val.apply(val, args)
  } else {
    return val
  }
}

function calculateFileKey(entry, fileIdAttributes) {
  return fileIdAttributes
    .sort()
    .map(key => get(entry, key))
    .join('####')
}

function defaultValidateFile(fileDocument) {
  return checkFileSize(fileDocument)
}

async function defaultValidateFileContent(fileDocument) {
  if (!defaultValidateFile(fileDocument)) {
    log.warn('Wrong file type from content')
    return false
  }
  return true
}

function sanitizeEntry(entry) {
  delete entry.fetchFile
  delete entry.requestOptions
  delete entry.filestream
  delete entry.shouldReplaceFile
  return entry
}

function attachFileToEntry(entry, fileDocument) {
  entry.fileDocument = fileDocument
  return entry
}

function getFilePath({ file, entry, options }) {
  const folderPath = options.folderPath
  if (file) {
    return folderPath + '/' + getAttribute(file, 'name')
  } else if (entry) {
    return folderPath + '/' + getFileName(entry)
  }
}

function getAttribute(obj, attribute) {
  return get(obj, `attributes.${attribute}`, get(obj, attribute))
}

async function getOrCreateDestinationPath(client, entry, saveOptions) {
  const subPath = entry.subPath || saveOptions.subPath
  let finalPath = saveOptions.folderPath
  if (subPath) {
    finalPath += '/' + subPath
    await client.collection('io.cozy.files').createDirectoryByPath(finalPath)
  }
  return finalPath
}
