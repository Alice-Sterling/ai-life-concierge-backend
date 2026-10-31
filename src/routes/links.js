/**
 * GET /go/:site/:code -> 302 to the booking page behind a short link (see
 * src/services/shortLinks.js). Public: clients tap these in WhatsApp.
 * Unknown codes get a plain 404, never a redirect.
 */

const express = require('express');
const shortLinks = require('../services/shortLinks');

const router = express.Router();

// /go/uber/Xk3p9Q2a (site name for the reader, only the code is looked up),
// and the plain /go/Xk3p9Q2a that was sent before the name was added.
router.get(['/go/:site/:code', '/go/:code'], async (req, res, next) => {
  try {
    const url = await shortLinks.resolve(req.params.code, req.log);
    if (!url) return res.status(404).type('text/plain').send('This link has expired or does not exist.');
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, url);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
