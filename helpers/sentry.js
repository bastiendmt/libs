const log = require('../libs/logger')
const Raven = require('raven')

// Available in Projet > Settings > Client Keys
// Example : https://5f94cb7772deadbeef123456:39e4e34fdeadbeef123456a9ae31caba74c@sentry.cozycloud.cc/12
const SENTRY_DSN = process.env.SENTRY_DSN

const afterFatalError = function (err, sendErr, eventId) {
  if (!sendErr) {
    log('info', 'Successfully sent fatal error with eventId ' + eventId + ' to Sentry');
  }
  process.exit(1);
}

const afterCaptureException = function (sendErr, eventId) {
  if (!sendErr) {
    log('info', 'Successfully sent exception with eventId ' + eventId + ' to Sentry');
  }
  process.exit(1)
}

const setupSentry = function () {
  try {
    log('info', 'process.env.SENTRY_DSN found, setting up Raven')
    const release = typeof GIT_SHA !== 'undefined' ? GIT_SHA : 'dev'
    const environment = process.env.NODE_ENV
    Raven.config(SENTRY_DSN, { release, environment }).install(afterFatalError)
    log('info', 'Raven configured !')
  } catch (e) {
    log('warn', 'Could not load Raven, errors will not be sent to Sentry')
    log('warn', e)
  }
}

module.exports.captureExceptionAndDie = function (err) {
  log('info', 'Capture exception and die')
  if (!Raven) {
    process.exit(1)
  } else {
    try {
      log('info', 'Sending exception to Sentry')
      Raven.captureException(err, afterCaptureException)
    } catch (e) {
      log('warn', 'Could not send error to Sentry, exiting...')
      log('warn', e)
      process.exit(1)
    }
  }
}

module.exports.wrapIfSentrySetUp = function (obj, method) {
  if (SENTRY_DSN) {
    obj[method] = Raven.wrap(obj[method])
  }
}

if (SENTRY_DSN) {
  setupSentry()
}
