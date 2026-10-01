import { hashAdminPassword } from "../src/authorization/password-authorization.ts";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const password = input.trimEnd();
  if (password.length === 0) throw new Error("Provide the password on stdin; it is never echoed or logged");
  process.stdout.write(`${hashAdminPassword(password)}\n`);
});
