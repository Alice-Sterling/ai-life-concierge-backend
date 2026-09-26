/**
 * Public landing page.
 *
 * Server-rendered HTML, moved verbatim from index.js. Content-Security-Policy is
 * disabled in the security middleware because this page uses inline styles; if
 * the markup is ever moved to static assets, CSP should be switched back on.
 *
 * A view is recorded as a funnel event. It is fire-and-forget: analytics must
 * never delay or fail the page.
 */

const express = require('express');
const events = require('../services/events');

const router = express.Router();

router.get('/', (req, res) => {
  events.record(events.EVENT.PORTAL_VIEWED, { requestId: req.requestId }, req.log);

  const waUrl =
    'https://wa.me/441483694296?text=' +
    encodeURIComponent(
      "I'm ready to reclaim 10+ hours, but I'm just getting started. What can you help me with?"
    );
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Natural Opening — Ai Life Concierge</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      min-height: 100%;
      min-height: -webkit-fill-available;
    }
    body {
      background: #000000;
      color: #D4AF37;
      font-family: "Instrument Serif", Georgia, "Times New Roman", serif;
      -webkit-tap-highlight-color: transparent;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    .stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      min-height: 100dvh;
      width: 100%;
      padding: 1.25rem 1rem 2rem;
    }
    .natural-scene {
      perspective: 1200px;
      -webkit-perspective: 1200px;
      transform-style: preserve-3d;
      -webkit-transform-style: preserve-3d;
    }
    .envelope-hit {
      cursor: pointer;
      outline: none;
      display: block;
    }
    .envelope-hit:focus-visible {
      box-shadow: 0 0 0 2px rgba(212, 175, 55, 0.45);
      border-radius: 8px;
    }
    .natural-svg {
      display: block;
      width: 60vw;
      max-width: 380px;
      height: auto;
      overflow: visible;
      transform-style: preserve-3d;
      -webkit-transform-style: preserve-3d;
      filter: drop-shadow(0 14px 32px rgba(0, 0, 0, 0.8));
    }
    @media (min-width: 769px) {
      .natural-svg { width: min(340px, 42vw); }
    }
    .natural-flap {
      transform-origin: 160px 118px;
      transform: rotateX(0deg);
      -webkit-transform: rotateX(0deg);
      transition: transform 0.6s ease;
      -webkit-transition: -webkit-transform 0.6s ease;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
    }
    .natural-root.opened .natural-flap {
      transform: rotateX(180deg);
      -webkit-transform: rotateX(180deg);
    }
    .natural-letter {
      transform: translateY(0);
      transition: transform 0.45s ease 0.3s;
    }
    .natural-root.opened .natural-letter {
      transform: translateY(-40px);
    }
    .footer-msg {
      margin-top: 2rem;
      text-align: center;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 2px;
      line-height: 1.45;
      text-transform: uppercase;
      color: #D4AF37;
      max-width: 24rem;
      padding: 0 0.5rem;
      opacity: 1;
      transition: opacity 0.4s ease;
    }
    @media (max-width: 768px) {
      .footer-msg { font-size: 1.8rem; }
    }
    .footer-msg.switching { opacity: 0; }
  </style>
</head>
<body>
  <div class="stage">
    <div class="natural-root" id="naturalRoot">
      <div class="natural-scene">
        <div class="envelope-hit" id="envelopeBtn" role="button" tabindex="0" aria-label="Open envelope — continue to WhatsApp">
          <svg class="natural-svg" viewBox="0 0 320 260" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <linearGradient id="natCharcoal" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#222"/>
                <stop offset="100%" style="stop-color:#1a1a1a"/>
              </linearGradient>
              <linearGradient id="natSide" x1="0%" y1="100%" x2="100%" y2="0%">
                <stop offset="0%" style="stop-color:#121212"/>
                <stop offset="100%" style="stop-color:#1f1f1f"/>
              </linearGradient>
            </defs>
            <rect width="320" height="260" fill="#000000"/>
            <path fill="#1a1a1a" stroke="#D4AF37" stroke-width="1.8" stroke-linejoin="round"
              d="M32 118 L160 118 L288 118 L288 228 Q288 238 278 238 L42 238 Q32 238 32 228 Z"/>
            <g class="natural-letter">
              <rect x="78" y="148" width="164" height="76" rx="3" fill="#141414" stroke="#D4AF37" stroke-width="1.15"/>
              <line x1="98" y1="168" x2="222" y2="168" stroke="#D4AF37" stroke-width="0.35" opacity="0.45"/>
              <line x1="98" y1="182" x2="198" y2="182" stroke="#D4AF37" stroke-width="0.35" opacity="0.35"/>
              <line x1="98" y1="196" x2="210" y2="196" stroke="#D4AF37" stroke-width="0.35" opacity="0.3"/>
            </g>
            <path fill="url(#natSide)" stroke="#D4AF37" stroke-width="1.35" stroke-linejoin="round" opacity="0.95"
              d="M32 118 L160 200 L32 228 Z"/>
            <path fill="url(#natSide)" stroke="#D4AF37" stroke-width="1.35" stroke-linejoin="round" opacity="0.95"
              d="M288 118 L160 200 L288 228 Z"/>
            <path fill="#1a1a1a" stroke="#D4AF37" stroke-width="1.5" stroke-linejoin="round"
              d="M32 228 L160 155 L288 228"/>
            <g class="natural-flap">
              <path fill="url(#natCharcoal)" stroke="#D4AF37" stroke-width="2" stroke-linejoin="round"
                d="M32 118 L160 38 L288 118 Z"/>
              <path d="M32 118 L160 38 L288 118" fill="none" stroke="#D4AF37" stroke-width="0.85" opacity="0.4"/>
              <line x1="160" y1="48" x2="160" y2="108" stroke="#D4AF37" stroke-width="0.5" opacity="0.25"/>
            </g>
          </svg>
        </div>
      </div>
    </div>
    <p class="footer-msg" id="naturalFooter">YOUR INVITATION TO ACTIVATE AI LIFE CONCIERGE</p>
  </div>
  <script>
    (function () {
      var root = document.getElementById('naturalRoot');
      var btn = document.getElementById('envelopeBtn');
      var footer = document.getElementById('naturalFooter');
      var done = false;
      var wa = ${JSON.stringify(waUrl)};
      function openNatural() {
        if (done) return;
        done = true;
        try {
          if (navigator.vibrate) navigator.vibrate([40, 20, 40]);
        } catch (e) {}
        root.classList.add('opened');
        footer.classList.add('switching');
        setTimeout(function () {
          footer.textContent = 'OPENING YOUR VAULT...';
          footer.classList.remove('switching');
        }, 200);
        setTimeout(function () {
          try {
            window.location.href = wa;
          } catch (err) {
            window.location.assign(wa);
          }
        }, 1100);
      }
      btn.addEventListener('click', openNatural);
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openNatural();
        }
      });
    })();
  </script>
</body>
</html>`);
});


module.exports = router;
