export const TUNNEL_PROTOCOLS = ["auto", "quic", "http2"] as const;
export type TunnelProtocol = (typeof TUNNEL_PROTOCOLS)[number];

export function resolveTunnelProtocol(env: NodeJS.Dict<string> = process.env): TunnelProtocol | null {
  const raw = env.C2C_TUNNEL_PROTOCOL?.trim();
  if (!raw) return null;
  const value = raw.toLowerCase();
  if ((TUNNEL_PROTOCOLS as readonly string[]).includes(value)) return value as TunnelProtocol;
  throw new Error(`C2C_TUNNEL_PROTOCOL must be one of ${TUNNEL_PROTOCOLS.join(", ")}`);
}

export function tunnelProtocolArgs(protocol: TunnelProtocol | null = resolveTunnelProtocol()): string[] {
  return protocol ? ["--protocol", protocol] : [];
}

export function resolveTunnelEdge(env: NodeJS.Dict<string> = process.env): string | null {
  const raw = env.C2C_CF_EDGE?.trim();
  if (!raw) return null;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(raw)) {
    throw new Error("C2C_CF_EDGE must look like 198.41.192.167:7844");
  }
  return raw;
}

export function tunnelEdgeArgs(edge: string | null = resolveTunnelEdge()): string[] {
  return edge ? ["--edge", edge] : [];
}
