// Prints a new SEAL_KEY (32 random bytes, base64) for `wrangler secret put SEAL_KEY`. Writes nothing.
// Replacing it makes every stored token unreadable: everyone sets up their feed and Google again.
const bytes = crypto.getRandomValues(new Uint8Array(32));
console.log(btoa(String.fromCharCode(...bytes)));
