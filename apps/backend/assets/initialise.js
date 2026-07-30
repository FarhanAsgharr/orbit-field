/**
 * Boots Swagger UI against this API's own document.
 *
 * A separate file rather than an inline <script> because the API sets
 * `script-src 'self'` with no 'unsafe-inline', so an inline block would be
 * blocked. Kept here, in one place, so the copy Express serves in development
 * and the copy Vercel serves in production cannot disagree.
 */
window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
    persistAuthorization: true,
    tryItOutEnabled: true,
  });
};
