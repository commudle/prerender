const util = require('../util');

// Base domains we almost always want to block for faster rendering (tracking, ads, heavy analytics)
const baseBlockedSubstrings = [
  'google-analytics.com',
  'api.mixpanel.com',
  'stats.g.doubleclick.net',
  'mc.yandex.ru',
  'beacon.tapfiliate.com',
  'js-agent.newrelic.com',
  'api.segment.io',
  'woopra.com',
  'static.olark.com',
  'static.getclicky.com',
  'cdn.heapanalytics.com',
  'googleads.g.doubleclick.net',
  'pagead2.googlesyndication.com',
  'fullstory.com/rec',
  'navilytics.com/nls_ajax.php',
  'log.optimizely.com',
  'hn.inspectlet.com',
  'tpc.googlesyndication.com',
  'partner.googleadservices.com',
  'maps.googleapis.com/maps/api/mapsjs/gen_204',
  'maps.googleapis.com/maps-api-v3',
  '.razorpay.com',
  '.stripe.com',
  'ingest.sentry.io',
];

// Fonts are heavy but often safe to block for prerendered HTML (CSS fallback will apply).
const fontExtensions = ['.ttf', '.eot', '.otf', '.woff', '.woff2'];
// High-resolution images can be optionally blocked (we default to NOT blocking to allow critical images).
const imageExtensions = [
  '.png',
  '.gif',
  '.tiff',
  '.pdf', // embedded pdfs
  '.jpg',
  '.jpeg',
  '.ico',
  '.svg',
];

function buildBlockedList() {
  const blockImages =
    process.env.BLOCK_RESOURCES_BLOCK_IMAGES === 'true' ||
    process.env.BLOCK_RESOURCES_BLOCK_IMAGES === '1';
  const blocked = [...baseBlockedSubstrings];

  // Always include fonts unless explicitly disabled
  const disableFontBlocking =
    process.env.BLOCK_RESOURCES_BLOCK_FONTS === 'false' ||
    process.env.BLOCK_RESOURCES_BLOCK_FONTS === '0';
  if (!disableFontBlocking) blocked.push(...fontExtensions);

  if (blockImages) blocked.push(...imageExtensions);

  // Allowlist overrides: comma separated domains substrings that should never be blocked
  const allow = (process.env.BLOCK_RESOURCES_ALLOW_DOMAINS || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  return { blocked, allow, blockImages };
}

function shouldSkip(requestUrl, allowList) {
  return allowList.some((allow) => requestUrl.includes(allow));
}

module.exports = {
  tabCreated: (req, res, next) => {
    const { blocked, allow, blockImages } = buildBlockedList();
    const log =
      req.prerender.logRequests ||
      process.env.BLOCK_RESOURCES_LOG === 'true' ||
      process.env.BLOCK_RESOURCES_LOG === '1';

    req.prerender.tab.Network.setRequestInterception({
      patterns: [{ urlPattern: '*' }],
    })
      .then(() => {
        next();
      })
      .catch((err) => {
        util.log('Failed to enable request interception', err);
        next();
      });

    req.prerender.tab._isClosing = false; // defensive flag (may be set elsewhere on close)

    req.prerender.tab.Network.requestIntercepted(
      ({ interceptionId, request }) => {
        if (req.prerender.tab._isClosing) {
          return; // don't attempt to send commands while closing
        }

        const url = request.url;
        if (shouldSkip(url, allow)) {
          return req.prerender.tab.Network.continueInterceptedRequest({
            interceptionId,
          });
        }

        let shouldBlock = false;
        for (const substring of blocked) {
          if (url.includes(substring)) {
            shouldBlock = true;
            break;
          }
        }

        const interceptOptions = { interceptionId };
        if (shouldBlock) {
          interceptOptions.errorReason = 'Aborted';
          if (log) util.log('[blockResources] blocked', url);
        } else if (log && blockImages) {
          // When images blocked globally we log allowed ones for debugging
          util.log('[blockResources] allowed', url);
        }

        try {
          req.prerender.tab.Network.continueInterceptedRequest(
            interceptOptions,
          );
        } catch (e) {
          // Avoid crashing on WebSocket closing
          // readyState check not exposed easily here; swallow known closing error
          if (log)
            util.log(
              '[blockResources] continueInterceptedRequest failed (probably closing):',
              e && e.message ? e.message : e,
            );
        }
      },
    );
  },
};
