/** Model egress policy, separate from the Desktop listener's loopback policy.
 * HTTP supports user-configured gateways but provides no transport encryption.
 * Never put credentials in the URL; the model adapter owns Authorization. */
export function modelEndpoint(value: unknown): URL {
  if (typeof value !== "string") throw new TypeError("desktop_model_endpoint_invalid");
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new TypeError("desktop_model_endpoint_invalid"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["https:", "http:"].includes(endpoint.protocol)) throw new TypeError("desktop_model_endpoint_invalid");
  return endpoint;
}
