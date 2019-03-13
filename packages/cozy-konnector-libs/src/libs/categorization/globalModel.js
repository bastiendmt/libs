const bayes = require('classificator')
const logger = require('cozy-logger')
const maxBy = require('lodash/maxBy')
const cozyClient = require('../cozyclient')
const { getLabelWithTags } = require('./helpers')

const log = logger.namespace('global-categorization-model')

const PARAMETERS_NOT_FOUND = 'Classifier files is not configured.'

const createClassifier = (data, options = {}) => {
  // Use for automated tests only while we don't have a clean parameters JSON file
  // We can remove this when we have it, and update the tests to use it
  if (!data) {
    const toLearn = require('./set_label_cat.json')

    const classifier = bayes(options)

    for (const { label, category } of toLearn) {
      classifier.learn(label, category)
    }

    return classifier
  }

  data.options = {
    ...data.options,
    ...options
  }

  const classifier = bayes.fromJson(data)

  // Display classifier to compare with python file
  // console.log('classifier', classifier.toJson())

  return classifier
}

const fetchParameters = async () => {
  try {
    const parameters = await cozyClient.fetchJSON(
      'GET',
      '/remote/assets/bank_classifier_nb_and_voc'
    )
    return parameters
  } catch (e) {
    log('info', e.message)
    throw new Error(PARAMETERS_NOT_FOUND)
  }
}

const globalModel = async (classifierOptions, transactions) => {
  log('info', 'Fetching parameters from the stack')
  let parameters

  try {
    parameters = await fetchParameters()
    log('info', 'Successfully fetched parameters from the stack')
  } catch (e) {
    log('info', e)
    return
  }

  log('info', 'Instanciating a new classifier')
  const classifier = createClassifier(parameters, classifierOptions)

  for (const transaction of transactions) {
    const label = getLabelWithTags(transaction)
    log('info', `Applying model to ${label}`)

    const { category, proba } = maxBy(
      classifier.categorize(label).likelihoods,
      'proba'
    )

    transaction.cozyCategoryId = category
    transaction.cozyCategoryProba = proba

    log('info', `Results for ${label} :`)
    log('info', `cozyCategory: ${category}`)
    log('info', `cozyProba: ${proba}`)
  }
}

module.exports = {
  createClassifier,
  globalModel
}
