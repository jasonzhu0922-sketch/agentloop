import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// WiX v4 needs explicit components. Stable path-derived IDs and one file per
// component keep component identity unchanged across major upgrades.
export async function windowsMsiPayload(payloadRoot) {
  const components = [];
  async function directory(root, relative = "") {
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    const elements = [];
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const id = createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 32);
      if (entry.isDirectory()) {
        elements.push(`<Directory Id="D_${id}" Name="${xml(entry.name)}">${await directory(join(root, entry.name), path)}</Directory>`);
      } else if (entry.isFile()) {
        const fileId = path === "AgentLoop Local Runtime.exe" ? "TrayExecutable" : `F_${id}`;
        components.push(`C_${id}`);
        elements.push(`<Component Id="C_${id}" Guid="*" Bitness="always64"><File Id="${fileId}" Source="${xml(join(root, entry.name))}" KeyPath="yes" /></Component>`);
      } else {
        throw new Error(`Unsupported MSI payload entry: ${path}`);
      }
    }
    return elements.join("\n");
  }
  const directories = await directory(payloadRoot);
  return `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Fragment><DirectoryRef Id="INSTALLFOLDER">${directories}</DirectoryRef><ComponentGroup Id="RuntimePayload">${components.map(id => `<ComponentRef Id="${id}" />`).join("\n")}</ComponentGroup></Fragment></Wix>\n`;
}

function xml(value) {
  return value.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[value]);
}
