import assert from "node:assert/strict";
import test from "node:test";
import { profileForMatching } from "../src/planner.js";
import { ProfileSchema } from "../src/types.js";

const profile = ProfileSchema.parse({
  identity: { firstName: "A", lastName: "B", email: "a@example.com", phone: "1", city: "Delhi", country: "India" },
  links: {}, workAuthorization: { authorizedCountries: ["India"], requiresSponsorship: false },
  experience: { currentTitle: "Consultant", years: 5, skills: ["Research"], summary: "Verified" },
  education: [], preferences: {}, applicationPolicy: { dailyTarget: 30, acceptedMatchBands: ["top", "medium"] },
  voluntaryDisclosures: {},
  resumeSets: [{
    id: "consulting", name: "Consulting", targetRoles: ["Strategy Consultant"], skills: ["Research"], summary: "Verified strategy experience",
    resumePath: "/private/Resumes/private.pdf", coverLetterPath: "/private/cover-letter.txt"
  }]
});

test("ranking payload metadata omits local résumé and cover-letter paths", () => {
  const matchingProfile = profileForMatching(profile);
  assert.deepEqual(matchingProfile.resumeSets, [{
    id: "consulting", name: "Consulting", targetRoles: ["Strategy Consultant"], skills: ["Research"], summary: "Verified strategy experience"
  }]);
  assert.equal(JSON.stringify(matchingProfile).includes("/private/"), false);
});