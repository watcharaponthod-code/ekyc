const { withAndroidManifest } = require('expo/config-plugins')

/**
 * Allow plain HTTP on Android.
 *
 * Android 9 blocks cleartext traffic by default. Expo's generated *debug*
 * manifest opts back in, but the *release* manifest does not — so a release
 * build silently fails every request to an `http://` server while the same URL
 * downloads fine in a browser. That is exactly the shape of bug that eats an
 * afternoon, so it is fixed here rather than rediscovered.
 *
 * This is for the demo, which talks to an eKYC server on the LAN over HTTP.
 * **Production must use TLS** and drop this plugin — see the hardening section
 * of the design spec.
 */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0]
    if (application) {
      application.$['android:usesCleartextTraffic'] = 'true'
    }
    return mod
  })
}
