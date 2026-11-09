import {WRITE_PROFILE,validDemoResource}from"../executor/demo-receipt-contract.js";
export type DockerInstallation = { name: string; image: string; network: string; apiContainer: string; secretsVolume: string; ledgerVolume: string; profile?:string; outputVolume?:string; outputResource?:string };
/** Host-administrator preflight. Not cryptographic attestation of a remote host. */
export function validateDockerProfile(container: any, network: any, api: any, expected: DockerInstallation) {
  const write=expected.profile===WRITE_PROFILE;
  if((expected.profile!==undefined&&!write)||(write&&(!expected.outputVolume||!validDemoResource(expected.outputResource)||[expected.ledgerVolume,expected.secretsVolume].includes(expected.outputVolume)))||(!write&&(expected.outputVolume!==undefined||expected.outputResource!==undefined)))throw new Error("Invalid fixed Docker profile");
  const h = container.HostConfig, c = container.Config;
  const mounts = container.Mounts ?? [], connected = Object.keys(container.NetworkSettings.Networks);
  if (c.User !== "10001:10001" || !h.ReadonlyRootfs || h.Privileged || h.NetworkMode !== expected.network ||
    !h.CapDrop?.includes("ALL") || h.CapAdd?.length || !h.SecurityOpt?.some((x: string) => /^no-new-privileges(?::true)?$/.test(x)) ||
    !h.Memory || h.Memory > 268435456 || !h.NanoCpus || h.NanoCpus > 1000000000 || !h.PidsLimit || h.PidsLimit > 128 ||
    Object.keys(h.PortBindings ?? {}).length || connected.length !== 1 || connected[0] !== expected.network ||
    !h.Mounts?.every((m:any)=>m.VolumeOptions?.NoCopy===true) || h.Mounts.length!==(write?3:2) ||
    mounts.length !== (write?3:2) || (write&&!mounts.some((m:any)=>m.Type==="volume"&&m.Name===expected.outputVolume&&m.Destination==="/demo-output"&&m.RW)) || !mounts.some((m: any) => m.Type === "volume" && m.Name === expected.ledgerVolume && m.Destination === "/ledger" && m.RW) ||
    !mounts.some((m: any) => m.Type === "volume" && m.Name === expected.secretsVolume && m.Destination === "/secrets" && !m.RW) ||
    JSON.stringify(c.Entrypoint) !== JSON.stringify(["node", "/app/main.mjs"]) || c.Cmd?.length)
    throw new Error("Executor Docker isolation profile rejected");
  if (!network.Internal || network.Driver !== "bridge" || network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
    Object.values(network.Containers ?? {}).some((x: any) => ![expected.name, expected.apiContainer].includes(x.Name)) ||
    Object.keys(api.HostConfig.PortBindings ?? {}).length || api.HostConfig.NetworkMode === "host" || api.HostConfig.Privileged ||
    !api.NetworkSettings.Networks?.[expected.network]) throw new Error("Private API network isolation rejected");
}
