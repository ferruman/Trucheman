/** Match a provider endpoint by its parsed hostname, never by an attacker-controlled substring. */
export function isEndpointHost(endpoint: string, expectedHostname: string): boolean {
  try {
    return new URL(endpoint).hostname.toLowerCase() === expectedHostname.toLowerCase();
  } catch {
    return false;
  }
}
