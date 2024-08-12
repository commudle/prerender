module.exports = {
  pageLoaded: (req, res, next) => {
    if (!req.prerender.content || req.prerender.renderType != 'html') {
      return next();
    }

    req.prerender.content = req.prerender.content
      .toString()
      .replace(/const isBot = false;/, `const isBot = true;`);

    next();
  },
};
