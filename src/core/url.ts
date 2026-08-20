export interface NormalizeUrlOptions {
  trackingParameters?: ReadonlySet<string>;
  httpsUpgradeHosts?: ReadonlySet<string>;
}

const DEFAULT_TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
]);

const UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;

export function normalizeUrl(
  input: string | URL,
  base?: string | URL,
  options: NormalizeUrlOptions = {},
): string {
  const url = base === undefined ? new URL(input) : new URL(input, base);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`Unsupported URL protocol: ${url.protocol}`);
  }

  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  if (
    url.protocol === "http:" &&
    options.httpsUpgradeHosts?.has(url.host.toLowerCase())
  ) {
    url.protocol = "https:";
  }

  url.pathname = normalizePercentEncoding(url.pathname || "/");
  url.search = normalizeQuery(url.searchParams, options.trackingParameters);

  return url.href;
}

function normalizeQuery(
  searchParams: URLSearchParams,
  extraTrackingParameters?: ReadonlySet<string>,
): string {
  const retained = [...searchParams.entries()]
    .filter(([key]) => !isTrackingParameter(key, extraTrackingParameters))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey.localeCompare(rightKey);
      return keyOrder !== 0 ? keyOrder : leftValue.localeCompare(rightValue);
    });

  if (retained.length === 0) {
    return "";
  }

  return `?${retained
    .map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`)
    .join("&")}`;
}

function isTrackingParameter(
  key: string,
  extraTrackingParameters?: ReadonlySet<string>,
): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    normalizedKey.startsWith("utm_") ||
    DEFAULT_TRACKING_PARAMETERS.has(normalizedKey) ||
    extraTrackingParameters?.has(normalizedKey) === true
  );
}

function encodeQueryPart(value: string): string {
  return normalizePercentEncoding(encodeURIComponent(value));
}

function normalizePercentEncoding(value: string): string {
  return value.replace(/%[0-9a-fA-F]{2}/g, (sequence) => {
    const character = String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
    return UNRESERVED_CHARACTER.test(character)
      ? character
      : sequence.toUpperCase();
  });
}
