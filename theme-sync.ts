import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+shift+t", {
		description: "Sync theme with macOS",
		handler: async (ctx) => {
			try {
				const { stdout } = await pi.exec("defaults", [
					"read",
					"-g",
					"AppleInterfaceStyle",
				]);
				ctx.ui.setTheme(
					stdout.trim() === "Dark" ? "dark" : "light",
				);
			} catch {
				// AppleInterfaceStyle missing = light mode
				ctx.ui.setTheme("light");
			}
		},
	});
}
