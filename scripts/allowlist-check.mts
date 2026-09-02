/**
 * The group allowlist gate: which chats the bot may act in at all, checked in the webhook route
 * before tagging, capture or recording are even considered.
 *
 * Needs no keys and no database.
 *
 *   npm run allowlist-check
 */
import { isAllowedChat } from "../lib/allowlist.js";

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(
    pass ? "  PASS" : "  FAIL",
    label,
    pass ? "" : `— got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`,
  );
};

console.log("\ngroups:");
check(
  "group not in allowlist is dropped",
  isAllowedChat("123@g.us", ["999@g.us"], false, false),
  false,
);
check(
  "group in allowlist passes",
  isAllowedChat("999@g.us", ["999@g.us"], false, false),
  true,
);
check("empty allowlist blocks all groups", isAllowedChat("1@g.us", [], false, false), false);
check(
  "allowlist is exact-match, not a prefix",
  isAllowedChat("999@g.us-imposter", ["999@g.us"], false, false),
  false,
);
check(
  "a chat outside the allowlist is dropped even with other groups configured",
  isAllowedChat("1@g.us", ["2@g.us", "3@g.us"], false, false),
  false,
);

console.log("\ndirect messages:");
check(
  "dm honored by replyToDms flag",
  isAllowedChat("1@s.whatsapp.net", [], true, true),
  true,
);
check(
  "dm blocked when replyToDms is off",
  isAllowedChat("1@s.whatsapp.net", [], true, false),
  false,
);
check(
  "a dm ignores the allowlist entirely, even if its JID is somehow listed",
  isAllowedChat("1@s.whatsapp.net", ["1@s.whatsapp.net"], true, true),
  true,
);

console.log("\nneither a group nor flagged as a dm (broadcasts, status updates):");
check(
  "a non-@g.us chat is never allowed, even if listed",
  isAllowedChat("status@broadcast", ["status@broadcast"], false, false),
  false,
);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
