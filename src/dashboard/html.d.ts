/**
 * File: src/dashboard/html.d.ts
 * Author: Dann Bleeker Pedersen
 * Created: 2026-07-10
 * Last Updated: 2026-07-10
 * Version: 1.0.0
 * Description: Type shim for the wrangler.jsonc Text-module rule that imports
 *              *.html files as strings (used by handler.ts for page.html).
 *
 * Change log:
 *   1.0.0 (2026-07-10) — Initial (v1.12.0 dashboard release).
 */

declare module "*.html" {
	const content: string;
	export default content;
}
