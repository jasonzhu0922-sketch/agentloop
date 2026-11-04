import { restoreLegacyModels } from "../src/accounts/restore-legacy-models.ts";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--data-dir" || args[2] !== "--account-id") {
  console.error("用法：npm run restore:desktop-models -- --data-dir <开发数据目录> --account-id <明确指定的账号 ID>；请先停止 Desktop。");
  process.exitCode = 1;
} else {
  try {
    const result = await restoreLegacyModels(args[1]!, args[3]!);
    console.log(`已恢复 ${result.providers} 个 Provider、${result.models} 个模型到指定账号；旧配置保留不变。`);
  } catch (error) {
    // Never print provider JSON, endpoint URLs, decrypted keys or raw exceptions.
    const known = ["desktop_stop_before_model_recovery", "legacy_model_configuration_missing", "legacy_model_configuration_empty", "legacy_model_credentials_missing", "account_model_configuration_already_exists", "desktop_account_marker_invalid"];
    console.error(known.includes((error as Error).message) ? (error as Error).message : "模型恢复失败，未确认完成。请检查目标账号和旧配置。");
    process.exitCode = 1;
  }
}
