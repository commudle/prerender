const util = require('./util.js');
const validUrl = require('valid-url');
const { v4: uuidv4 } = require('uuid');

const WAIT_AFTER_LAST_REQUEST = process.env.WAIT_AFTER_LAST_REQUEST || 500;

const PAGE_DONE_CHECK_INTERVAL = process.env.PAGE_DONE_CHECK_INTERVAL || 500;

const PAGE_LOAD_TIMEOUT = process.env.PAGE_LOAD_TIMEOUT || 20 * 1000;

const FOLLOW_REDIRECTS = process.env.FOLLOW_REDIRECTS || false;

const LOG_REQUESTS = process.env.LOG_REQUESTS || false;

const CAPTURE_CONSOLE_LOG = process.env.CAPTURE_CONSOLE_LOG || false;

const ENABLE_SERVICE_WORKER = process.env.ENABLE_SERVICE_WORKER || false;

//try to restart the browser only if there are zero requests in flight
const BROWSER_TRY_RESTART_PERIOD =
  process.env.BROWSER_TRY_RESTART_PERIOD || 600000;

const BROWSER_DEBUGGING_PORT = process.env.BROWSER_DEBUGGING_PORT || 9222;

const TIMEOUT_STATUS_CODE = process.env.TIMEOUT_STATUS_CODE;

const PARSE_SHADOW_DOM = process.env.PARSE_SHADOW_DOM || false;

const server = (exports = module.exports = {});

server.init = function (options) {
  this.plugins = this.plugins || [];
  this.options = options || {};

  this.options.waitAfterLastRequest =
    this.options.waitAfterLastRequest || WAIT_AFTER_LAST_REQUEST;
  this.options.pageDoneCheckInterval =
    this.options.pageDoneCheckInterval || PAGE_DONE_CHECK_INTERVAL;
  this.options.pageLoadTimeout =
    this.options.pageLoadTimeout || PAGE_LOAD_TIMEOUT;
  this.options.followRedirects =
    this.options.followRedirects || FOLLOW_REDIRECTS;
  this.options.logRequests = this.options.logRequests || LOG_REQUESTS;
  this.options.captureConsoleLog =
    this.options.captureConsoleLog || CAPTURE_CONSOLE_LOG;
  this.options.enableServiceWorker =
    this.options.enableServiceWorker || ENABLE_SERVICE_WORKER;
  this.options.pdfOptions = this.options.pdfOptions || {
    printBackground: true,
  };
  this.options.browserDebuggingPort =
    this.options.browserDebuggingPort || BROWSER_DEBUGGING_PORT;
  this.options.timeoutStatusCode =
    this.options.timeoutStatusCode || TIMEOUT_STATUS_CODE;
  this.options.parseShadowDom = this.options.parseShadowDom || PARSE_SHADOW_DOM;
  this.options.browserTryRestartPeriod =
    this.options.browserTryRestartPeriod || BROWSER_TRY_RESTART_PERIOD;

  // Browser pool configuration
  this.options.maxConnections = this.options.maxConnections || 5;
  this.options.minConnections = this.options.minConnections || 1;
  this.options.maxIdleTime = this.options.maxIdleTime || 300000; // 5 minutes
  this.options.restartAfterUses = this.options.restartAfterUses || 100;

  const BrowserPool = require('./browserPool');
  this.browserPool = new BrowserPool(this.options);

  // Keep reference to old browser for compatibility
  this.browser = require('./browsers/chrome');

  return this;
};

server.start = function () {
  util.log('Starting Prerender with Browser Pool');
  this.isBrowserConnected = false;
  this.startPrerender()
    .then(() => {
      process.on('SIGINT', () => {
        this.shutdown();
      });

      process.on('SIGTERM', () => {
        this.shutdown();
      });
    })
    .catch(() => {
      if (process.exit) {
        process.exit();
      }
    });
};

server.startPrerender = function () {
  return new Promise((resolve, reject) => {
    // Initialize the browser pool instead of single browser
    this.browserPool
      .initializePool()
      .then(() => {
        this.browserRequestsInFlight = new Map();
        this.lastRestart = new Date().getTime();
        this.isBrowserConnected = true;
        util.log('Browser pool started successfully');
        return this.firePluginEvent('connectedToBrowser', { server });
      })
      .then(() => resolve())
      .catch((err) => {
        util.log(err);
        util.log('Failed to start browser pool');
        this.shutdown();
        reject();
      });
  });
};

server.addRequestToInFlight = function (req) {
  this.browserRequestsInFlight.set(req.prerender.reqId, req.prerender.url);
};

server.removeRequestFromInFlight = function (req) {
  this.browserRequestsInFlight.delete(req.prerender.reqId);
};

server.isAnyRequestInFlight = function () {
  return this.browserRequestsInFlight.size !== 0;
};

server.isThisTheOnlyInFlightRequest = function (req) {
  return (
    this.browserRequestsInFlight.size === 1 &&
    this.browserRequestsInFlight.has(req.prerender.reqId)
  );
};

server.spawnBrowser = function () {
  util.log(`Starting ${this.browser.name}`);
  return this.browser.spawn(this.options);
};

server.killBrowser = function () {
  util.log(`Stopping ${this.browser.name}`);
  this.isBrowserClosing = true;
  this.browser.kill();
};

server.restartBrowser = function () {
  // For compatibility, but browser pool handles this automatically
  util.log('Browser restart requested - pool will handle this automatically');
  // Don't actually restart, let the pool manage connections
};

server.connectToBrowser = function () {
  return this.browser.connect();
};

server.shutdown = function () {
  util.log('Shutting down Prerender');
  if (this.browserPool) {
    this.browserPool
      .shutdown()
      .then(() => {
        util.log('Prerender shutdown complete');
        process.exit();
      })
      .catch((err) => {
        util.log('Error during shutdown:', err);
        process.exit(1);
      });
  } else {
    this.killBrowser();
    setTimeout(() => {
      util.log('Stopping Prerender');
      process.exit();
    }, 500);
  }
};

server.getBrowserPoolStats = function () {
  if (this.browserPool) {
    return this.browserPool.getStats();
  }
  return null;
};

server.listenForBrowserClose = function () {
  // Browser pool handles connection management automatically
  // This method is kept for compatibility but doesn't need to do anything
  util.log('Browser close handling is managed by the browser pool');
};

server.waitForBrowserToConnect = function () {
  return new Promise((resolve, reject) => {
    var checks = 0;

    let check = () => {
      if (++checks > 100) {
        return reject(`Timed out waiting for browser pool connection`);
      }

      // Check if browser pool is ready instead of single browser
      if (
        !this.isBrowserConnected ||
        (this.browserPool && this.browserPool.getStats().totalConnections === 0)
      ) {
        return setTimeout(check, 200);
      }

      resolve();
    };

    check();
  });
};

server.use = function (plugin) {
  this.plugins.push(plugin);
  if (typeof plugin.init === 'function') plugin.init(this);
};

server.onRequest = function (req, res) {
  req.prerender = util.getOptions(req);
  // Do not rename reqId!
  req.prerender.reqId = uuidv4();
  req.prerender.renderId = uuidv4();
  req.prerender.start = new Date();
  req.prerender.responseSent = false;
  req.server = this;

  util.log('getting', req.prerender.url);
  if (this.browserRequestsInFlight === undefined) {
    return res.sendStatus(503);
  }
  this.addRequestToInFlight(req);

  this.firePluginEvent('requestReceived', req, res)
    .then(() => {
      if (!validUrl.isWebUri(encodeURI(req.prerender.url))) {
        util.log('invalid URL:', req.prerender.url);
        req.prerender.statusCode = 400;
        return Promise.reject();
      }

      req.prerender.startConnectingToBrowser = new Date();

      return this.firePluginEvent('connectingToBrowserStarted', req, res);
    })
    .then(() => this.waitForBrowserToConnect())
    .then(() => {
      req.prerender.startOpeningTab = new Date();

      //if there is a case where a page hangs, this will at least let us restart chrome
      setTimeout(() => {
        if (!req.prerender.responseSent) {
          util.log('response not sent for', req.prerender.url);
        }
        this.removeRequestFromInFlight(req);
      }, 60000);

      return this.browserPool.openTab(req.prerender);
    })
    .then((tab) => {
      req.prerender.endOpeningTab = new Date();
      req.prerender.tab = tab;

      return this.firePluginEvent('tabCreated', req, res);
    })
    .then(() => {
      req.prerender.startLoadingUrl = new Date();
      return req.prerender.tab._connection.browser.loadUrlThenWaitForPageLoadEvent(
        req.prerender.tab,
        req.prerender.url,
        () => this.firePluginEvent('tabNavigated', req, res),
      );
    })
    .then(() => {
      req.prerender.endLoadingUrl = new Date();

      if (req.prerender.javascript) {
        return req.prerender.tab._connection.browser.executeJavascript(
          req.prerender.tab,
          req.prerender.javascript,
        );
      } else {
        return Promise.resolve();
      }
    })
    .then(() => {
      return this.firePluginEvent('beforeParse', req, res);
    })
    .then(() => {
      req.prerender.startParse = new Date();

      if (req.prerender.renderType == 'png') {
        return req.prerender.tab._connection.browser.captureScreenshot(
          req.prerender.tab,
          'png',
          req.prerender.fullpage,
        );
      } else if (req.prerender.renderType == 'jpeg') {
        return req.prerender.tab._connection.browser.captureScreenshot(
          req.prerender.tab,
          'jpeg',
          req.prerender.fullpage,
        );
      } else if (req.prerender.renderType == 'pdf') {
        return req.prerender.tab._connection.browser.printToPDF(
          req.prerender.tab,
          this.options.pdfOptions,
        );
      } else if (req.prerender.renderType == 'har') {
        return req.prerender.tab._connection.browser.getHarFile(
          req.prerender.tab,
        );
      } else {
        return req.prerender.tab._connection.browser.parseHtmlFromPage(
          req.prerender.tab,
        );
      }
    })
    .then(() => {
      req.prerender.endParse = new Date();

      req.prerender.statusCode = req.prerender.tab.prerender.statusCode;
      req.prerender.prerenderData = req.prerender.tab.prerender.prerenderData;
      req.prerender.content = req.prerender.tab.prerender.content;
      req.prerender.headers = req.prerender.tab.prerender.headers;

      return this.firePluginEvent('pageLoaded', req, res);
    })
    .then(() => {
      this.finish(req, res);
    })
    .catch((err) => {
      if (err) util.log(err);
      req.prerender.startCatchError = new Date();
      this.finish(req, res);
    })
    .finally(() => {
      this.removeRequestFromInFlight(req);
    });
};

server.finish = function (req, res) {
  req.prerender.startFinish = new Date();

  if (req.prerender.tab) {
    // Use browser pool to close tab instead of direct browser call
    this.browserPool.closeTab(req.prerender.tab).catch((err) => {
      util.log('error closing Chrome tab', err);
    });
  }

  req.prerender.responseSent = true;
  this.removeRequestFromInFlight(req);

  // Browser pool handles connection lifecycle automatically
  // No need to manually restart browsers

  req.prerender.timeSpentConnectingToBrowser =
    (req.prerender.startOpeningTab || req.prerender.startFinish) -
      req.prerender.startConnectingToBrowser || 0;
  req.prerender.timeSpentOpeningTab =
    (req.prerender.endOpeningTab || req.prerender.startFinish) -
      req.prerender.startOpeningTab || 0;
  req.prerender.timeSpentLoadingUrl =
    (req.prerender.endLoadingUrl || req.prerender.startFinish) -
      req.prerender.startLoadingUrl || 0;
  req.prerender.timeSpentParsingPage =
    (req.prerender.endParse || req.prerender.startFinish) -
      req.prerender.startParse || 0;
  req.prerender.timeUntilError = 0;

  if (req.prerender.startCatchError) {
    req.prerender.timeUntilError =
      req.prerender.startCatchError - req.prerender.start;
  }

  this.firePluginEvent('beforeSend', req, res)
    .then(() => {
      this._send(req, res);
    })
    .catch(() => {
      this._send(req, res);
    });
};

server.firePluginEvent = function (methodName, req, res) {
  return new Promise((resolve, reject) => {
    let index = 0;
    let done = false;
    let next = null;
    let cancellationToken = null;
    var newRes = {};
    var args = [req, newRes];

    newRes.send = function (statusCode, content) {
      clearTimeout(cancellationToken);
      cancellationToken = null;

      if (statusCode) req.prerender.statusCode = statusCode;
      if (content) req.prerender.content = content;
      done = true;
      reject();
    };

    newRes.setHeader = function (key, value) {
      res.setHeader(key, value);
    };

    next = () => {
      clearTimeout(cancellationToken);
      cancellationToken = null;

      if (done) return;

      let layer = this.plugins[index++];
      if (!layer) {
        return resolve();
      }

      let method = layer[methodName];

      if (method) {
        try {
          cancellationToken = setTimeout(() => {
            util.log(
              `Plugin event ${methodName} timed out (10s), layer index: ${index}, url: ${req ? req.url : '-'}`,
            );
          }, 10000);

          method.apply(layer, args);
        } catch (e) {
          util.log(e);
          next();
        }
      } else {
        next();
      }
    };

    args.push(next);
    next();
  });
};

server._send = function (req, res) {
  req.prerender.statusCode = parseInt(req.prerender.statusCode) || 504;
  let contentTypes = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    pdf: 'application/pdf',
    har: 'application/json',
  };

  if (req.prerender.renderType == 'html') {
    Object.keys(req.prerender.headers || {}).forEach(function (header) {
      try {
        res.setHeader(header, req.prerender.headers[header].split('\n'));
      } catch (e) {
        util.log('warning: unable to set header:', header);
      }
    });
  }

  if (req.prerender.prerenderData) {
    res.setHeader('Content-Type', 'application/json');
  } else {
    res.setHeader(
      'Content-Type',
      contentTypes[req.prerender.renderType] || 'text/html;charset=UTF-8',
    );
  }

  if (!req.prerender.prerenderData) {
    if (req.prerender.content) {
      if (Buffer.isBuffer(req.prerender.content)) {
        res.setHeader('Content-Length', req.prerender.content.length);
      } else if (typeof req.prerender.content === 'string') {
        res.setHeader(
          'Content-Length',
          Buffer.byteLength(req.prerender.content, 'utf8'),
        );
      }
    }
  }

  //if the original server had a chunked encoding, we should remove it since we aren't sending a chunked response
  res.removeHeader('Transfer-Encoding');
  //if the original server wanted to keep the connection alive, let's close it
  res.removeHeader('Connection');

  res.removeHeader('Content-Encoding');

  if (req.prerender.statusCode === 504 && req.prerender.statusCodeReason) {
    res.setHeader('x-prerender-504-reason', req.prerender.statusCodeReason);
  }

  res.status(req.prerender.statusCode);

  if (req.prerender.prerenderData) {
    res.json({
      prerenderData: req.prerender.prerenderData,
      content: req.prerender.content,
    });
  }

  if (!req.prerender.prerenderData && req.prerender.content) {
    res.send(req.prerender.content);
  }

  if (!req.prerender.content) {
    res.end();
  }

  var ms = new Date().getTime() - req.prerender.start.getTime();
  util.log(
    'got',
    req.prerender.statusCode,
    'in',
    ms + 'ms',
    'for',
    req.prerender.url,
  );
};
