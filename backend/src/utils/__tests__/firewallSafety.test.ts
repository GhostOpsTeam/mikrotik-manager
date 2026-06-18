import { detectLockoutRisk } from '../firewallSafety';

describe('detectLockoutRisk', () => {
  it('flags a broad input-chain drop with no source scoping', () => {
    const r = detectLockoutRisk({ chain: 'input', action: 'drop' });
    expect(r.risky).toBe(true);
    expect(r.reason).toMatch(/lock MikroTik Manager/);
  });

  it('flags an unscoped input drop targeting a management port (ssh)', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', protocol: 'tcp', 'dst-port': '22' }).risky).toBe(true);
  });

  it('flags reject and tarpit the same as drop', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'reject' }).risky).toBe(true);
    expect(detectLockoutRisk({ chain: 'input', action: 'tarpit' }).risky).toBe(true);
  });

  it('does NOT flag rules scoped to a source address', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', 'src-address': '203.0.113.0/24' }).risky).toBe(false);
  });

  it('does NOT flag rules scoped to a source address-list (underscore key form)', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', src_address_list: 'Trusted' }).risky).toBe(false);
  });

  it('does NOT flag input drops on non-management ports only', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', protocol: 'tcp', 'dst-port': '12345' }).risky).toBe(false);
  });

  it('does NOT flag forward-chain drops (through-traffic, not device access)', () => {
    expect(detectLockoutRisk({ chain: 'forward', action: 'drop' }).risky).toBe(false);
  });

  it('does NOT flag accept rules', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'accept' }).risky).toBe(false);
  });

  it('does NOT flag disabled rules (both string forms)', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', disabled: 'yes' }).risky).toBe(false);
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', disabled: 'true' }).risky).toBe(false);
  });

  it('does NOT flag icmp/udp-only input drops', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', protocol: 'icmp' }).risky).toBe(false);
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', protocol: 'udp', 'dst-port': '53' }).risky).toBe(false);
  });

  it('flags an unscoped drop whose port range covers a management port', () => {
    expect(detectLockoutRisk({ chain: 'input', action: 'drop', protocol: 'tcp', 'dst-port': '8000-8800' }).risky).toBe(true); // covers 8291/8728/8729
  });
});
