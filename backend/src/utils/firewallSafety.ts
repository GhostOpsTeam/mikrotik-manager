// Lockout guard for firewall changes.
//
// MikroTik Manager controls devices over the RouterOS API (and admins reach
// them over SSH/Winbox). A careless `input`-chain drop/reject rule is the
// classic way to lock both the platform and the operator out of a device. This
// detects that rule shape so the UI can warn and require explicit confirmation
// before applying. It is intentionally conservative: it flags broad,
// unscoped input-chain blocks rather than trying to know the manager's exact
// source IP (which is unknowable through NAT).

export interface FirewallRuleLike {
  chain?: string;
  action?: string;
  protocol?: string;
  disabled?: string | boolean;
  // accept both RouterOS dashed keys and the API's underscore keys
  'src-address'?: string;
  src_address?: string;
  'dst-port'?: string;
  dst_port?: string;
  'src-address-list'?: string;
  src_address_list?: string;
}

// TCP management ports that, if blocked on the input chain, sever control:
// SSH(22), www(80)/ssl(443), Winbox(8291), API(8728)/API-SSL(8729).
export const DEFAULT_MGMT_PORTS = [22, 80, 443, 8291, 8728, 8729];

export interface LockoutResult {
  risky: boolean;
  reason: string;
}

function field(rule: FirewallRuleLike, dashed: keyof FirewallRuleLike, under: keyof FirewallRuleLike): string {
  const v = (rule[dashed] ?? rule[under] ?? '') as string;
  return String(v).trim();
}

// Parse a RouterOS port spec ("22", "80,443", "8000-8100") into a matcher.
function portSpecIncludes(spec: string, ports: number[]): boolean {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map((n) => parseInt(n, 10));
      if (Number.isFinite(lo) && Number.isFinite(hi) && ports.some((p) => p >= lo && p <= hi)) return true;
    } else {
      const n = parseInt(part, 10);
      if (Number.isFinite(n) && ports.includes(n)) return true;
    }
  }
  return false;
}

export function detectLockoutRisk(
  rule: FirewallRuleLike,
  opts: { mgmtPorts?: number[] } = {}
): LockoutResult {
  const ok = { risky: false, reason: '' };
  const mgmtPorts = opts.mgmtPorts ?? DEFAULT_MGMT_PORTS;

  const disabled = rule.disabled === true || rule.disabled === 'yes' || rule.disabled === 'true';
  if (disabled) return ok;

  const action = field(rule, 'action', 'action').toLowerCase();
  if (!['drop', 'reject', 'tarpit'].includes(action)) return ok;

  // Only the input chain governs access *to the device itself*.
  const chain = field(rule, 'chain', 'chain').toLowerCase();
  if (chain !== 'input') return ok;

  // Management access is TCP; an icmp/udp-only block isn't a lockout.
  const protocol = field(rule, 'protocol', 'protocol').toLowerCase();
  if (protocol && protocol !== 'tcp') return ok;

  // If the rule is scoped to a specific source (address or address-list), assume
  // the operator narrowed it deliberately and don't cry wolf.
  const srcAddr = field(rule, 'src-address', 'src_address');
  const srcList = field(rule, 'src-address-list', 'src_address_list');
  if (srcAddr || srcList) return ok;

  // Unscoped source. If it targets all ports, or explicitly a management port,
  // it would cut control.
  const dstPort = field(rule, 'dst-port', 'dst_port');
  const portsHit = !dstPort || portSpecIncludes(dstPort, mgmtPorts);
  if (!portsHit) return ok;

  return {
    risky: true,
    reason:
      `This input-chain "${action}" rule has no source restriction and would match management traffic ` +
      `(SSH/Winbox/API/HTTPS). Applying it can lock MikroTik Manager and admins out of the device. ` +
      `Scope it with a source address/list, or confirm to apply anyway.`,
  };
}
