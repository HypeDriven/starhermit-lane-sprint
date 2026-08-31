// Lane Sprint — platform: token-aware REST/WebSocket adapter, retries, rate-limit handling.
'use strict';

export function isHosted() { return true; }

let _launchToken = null;
export function setLaunchToken(t) { _launchToken = t; }
export function getLaunchToken() { return _launchToken; }
