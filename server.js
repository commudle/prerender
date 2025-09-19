let prerender = require('./lib');

let server = prerender({
  port: 8080,
  chromeFlags: [
    '--no-sandbox',
    '--headless',
    '--disable-gpu',
    '--remote-debugging-port=9222',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    // Additional performance flags
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI,VizDisplayCompositor',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-background-networking',
    '--no-first-run',
    '--memory-pressure-off',
  ],
  logRequests: true,
  pageLoadTimeout: 30 * 1000,
  waitAfterLastRequest: 2000,

  // Browser Pool Configuration
  maxConnections: 5, // Maximum number of Chrome instances
  minConnections: 2, // Keep at least 2 Chrome instances running
  maxIdleTime: 300000, // 5 minutes before idle connection is closed
  restartAfterUses: 100, // Restart Chrome after 100 page renders
  healthCheckInterval: 60000, // Health check every minute
});

server.use(prerender.sendPrerenderHeader());
server.use(prerender.browserForceRestart());
server.use(prerender.blockResources());
// server.use(prerender.removeScriptTags());
server.use(prerender.replaceIsBot());
server.use(prerender.addMetaTags());
server.use(prerender.httpHeaders());
server.use(require('prerender-memory-cache'));

server.start();
