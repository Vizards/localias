import { type Route } from '../config';

/**
 * Validate a domain name for use as a route.
 * Allows wildcard prefix `*.` (e.g. `*.example.com`).
 * Wildcards skip /etc/hosts — DNS is the user's responsibility.
 */
export function validateDomain(v: string): string | undefined {
  if (!v) return 'Enter a domain name';

  // Allow *.domain form — strip prefix for remaining validation
  let base = v;
  if (v.startsWith('*.')) {
    base = v.slice(2);
    if (!base) return 'Enter a domain after *. (e.g. *.example.com)';
  } else if (v.includes('*')) {
    return 'Wildcard must be the first label (e.g. *.example.com)';
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(base)) return 'Enter a valid domain name';
  // RFC 1035 §2.3.4: each DNS label must be ≤63 octets
  const labels = base.split('.');
  for (const label of labels) {
    if (label.length > 63) return `Label "${label.slice(0, 20)}…" exceeds 63-character DNS limit`;
    if (label.length === 0) return 'Empty label (double dot or trailing dot)';
  }
  return undefined;
}

/** Check whether a domain is a wildcard route. */
export function isWildcard(domain: string): boolean {
  return domain.startsWith('*.');
}

/** Check for duplicate domains among enabled routes. Returns error message or undefined. */
export function validateRouteConflicts(routes: Route[]): string | undefined {
  const domainsSeen = new Map<string, number>();
  for (const r of routes) {
    const key = r.domain.toLowerCase();
    const prev = domainsSeen.get(key);
    if (prev !== undefined) {
      return `Duplicate domain "${r.domain}" (ports ${prev} and ${r.target}). Disable one before starting.`;
    }
    domainsSeen.set(key, r.target);
  }

  // Check wildcard-vs-concrete overlap:
  // *.example.com and sub.example.com both enabled is allowed — exact match
  // takes priority in proxy.findRoute(). No conflict.
  return undefined;
}

/** Find IDs of duplicate-domain routes (keeps the first occurrence, returns the rest). */
export function findConflictRouteIds(routes: Route[]): string[] {
  const seen = new Set<string>();
  const conflicts: string[] = [];
  for (const r of routes) {
    const key = r.domain.toLowerCase();
    if (seen.has(key)) {
      conflicts.push(r.id);
    } else {
      seen.add(key);
    }
  }
  return conflicts;
}
