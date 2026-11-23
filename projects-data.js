// The Projects page's plain data (projects.html). Edit this file to change a plan; no rendering code needs touching.
//
// One entry in `projects` per project. The page lists them in a switcher and shows the selected one.
//
//   id            short lowercase id, used in the address (projects.html#rl)
//   name          what the switcher and the page call it
//   prefix        Ops board items whose title starts with this belong to the project
//   masterPrefix  the item that is the project's master roadmap (its title starts with this)
//   phasePrefix   phase items are "<phasePrefix><number>: Name" (RL R1: ... RL R10: ...); it starts with `prefix`
//   costsPhase    the phase number whose item is the costs register (linked from the Costs section)
//   intro, estimateNote   the planning-estimate wording shown on the page
//   milestones    where each milestone lands (summary tiles)
//   timeline      start month ("YYYY-MM"), how many month columns, then a "Later" column follows; tracks of rows of bars:
//                   bar = { from, to, label, kind }   from and to are the first and last column the bar covers (0 is the first month,
//                   `months` is the "Later" column); kind is build | owner | dash | soft (see `kinds`)
//   sittings      every sitting and act of the owner; kind "sitting" or "act"; `date` (YYYY-MM-DD, optional) is what "next sitting" uses
//   costs         the costs table; basis is a list of { tag: "ver" | "doc" | "est" | none, text }
//   scenarios     the scenario totals; assumptions: what the numbers rest on
//
// Dates and costs here are the Project Manager session's planning estimates, not commitments, and the page says so.
//
// Browser: window.BarnyardProjectsData. Node (tests): module.exports.

(function (root) {
  "use strict";

  var remoteLayout = {
    id: "rl",
    name: "Remote Layout",
    prefix: "RL ",
    masterPrefix: "RL roadmap: master",
    phasePrefix: "RL R",
    costsPhase: 10,

    title: "Remote Layout roadmap, sittings and costs",
    intro: "Updated Monday 23 November 2026 (Perth) by the Project Manager session. On 23 November you cancelled the staged sitting of build 0.0.4.3 and chose to earn the real-input safety evidence in a flow test that starts from a Setup install; Security lifted its rule that Setup waits for a passed sitting. Every date is a planning guess built from the Back End and Security design documents of 17 to 23 November; the figures carry roughly plus or minus 40%. Security's review time, not typing time, is the slowest part of every step. Costs are in Australian dollars unless a price is quoted in US dollars.",
    estimateNote: "Dates, durations and costs on this page are the Project Manager session's planning estimates, not commitments. They are kept in projects-data.js and are not read from the Ops board; only the phase cards are live.",

    milestones: [
      { label: "First flow test (Setup install, then drills)", value: "about Jan 2027", note: "Replaces the cancelled sitting. Setup slice 0 is 13 to 19 Engineer days for one Engineer (9 to 14 with two); Engineer B is on it; Security reads each step. Then two evenings: install plus Observe drills (about 85 to 90 minutes), Enforce drills (about 70 to 75 minutes). Back End's estimates, unmeasured." },
      { label: "Hosted control plane running (test tenancy)", value: "late Jan to Feb 2027", note: "About 21 Engineer days with two Engineers (33 with one), plus about 12 Security reads in series. Host chosen: control.flickerpane.com; server at Rackmill, not bought yet." },
      { label: "First named friend, scratch pad only", value: "Dec 2026 to Feb 2027", note: "On your LAN with you present from December; at a distance only after the hosted pilot." },
      { label: "One real window over the relay", value: "Feb to Mar 2027", note: "Window confinement, live transport, then the viewer. Needs real signing for a friend." },
      { label: "Unattended on your own VM", value: "Jun 2027", note: "Four to six months, in a fixed order. A friend's server follows." },
      { label: "Real customers", value: "late 2027 at best", note: "After a pilot, a penetration test, legal terms and insurance." }
    ],

    kinds: {
      build: "Engineering and review",
      owner: "Your acts and sittings",
      dash: "Design or reading only, nothing built",
      soft: "Other"
    },

    timeline: {
      start: "2026-11",
      months: 12,
      note: "Months run left to right from November 2026. Bars show build and review time.",
      tracks: [
        { id: "A", title: "Live product on Windows", rows: [
          { label: "Setup slice 0 (install-only installer, test build)", note: "Engineer B, branch setup-slice0-live from 0.0.4.3; Security reads each step; build is not run until his delivered-bytes gate", bars: [{ from: 0, to: 2, label: "Build and Security reads", kind: "build" }] },
          { label: "Flow test: install, then Observe and Enforce drills", note: "two evenings, replaces the staged sitting cancelled on 23 Nov; earns Security's word Enforce trusted (G10)", bars: [{ from: 2, to: 3, label: "Two evenings", kind: "owner" }] },
          { label: "Stop paths on the pad, hostile cases", note: "one evening, after Gate B", bars: [{ from: 3, to: 3, label: "Sitting", kind: "owner" }] },
          { label: "Real window control (S2)", note: "design, build, review, strings, byte search: 4 to 6 weeks", bars: [{ from: 1, to: 2, label: "Build and review", kind: "build" }] },
          { label: "Real window sitting and managed live (S3)", note: "two evenings", bars: [{ from: 2, to: 3, label: "Two sittings", kind: "owner" }] },
          { label: "Live agent over the relay (S6)", note: "6 to 8 weeks; relay sittings Feb to Mar", bars: [{ from: 1, to: 4, label: "Build, review, relay sittings (N1, S6, S6b)", kind: "build" }] },
          { label: "Screen viewer (S4)", note: "4 to 6 weeks, then two viewer sittings", bars: [{ from: 3, to: 4, label: "Viewer build and sittings", kind: "build" }] }
        ] },
        { id: "B", title: "Hosted control plane (new VPS, test tenancy)", rows: [
          { label: "Slices 0 to 5", note: "Engineer A: 0, 1, 2, 5; Engineer B: 3a, 4a, then 3b, 4b", bars: [{ from: 0, to: 2, label: "Build and Security reads", kind: "build" }] },
          { label: "Linux packages, VPS, first exposure", note: "G-H2, buy the Rackmill VPS late (after G-H2), G-H3a (only SSH), G-H3b, DNS last for control.flickerpane.com, which is your own act", bars: [{ from: 2, to: 2, label: "Your approvals and the VPS", kind: "owner" }] },
          { label: "Device builds for the pilot and pilot sittings (G-H4)", note: "8 to 12 Engineer days of wiring the relay into the programs, then 1 to 2 evenings", bars: [{ from: 2, to: 3, label: "Device wiring, then pilot sittings", kind: "owner" }] }
        ] },
        { id: "C", title: "Friends testing", rows: [
          { label: "Named friends on your LAN, you present", note: "scratch pad only, unsigned exception, at most two people", bars: [{ from: 1, to: 2, label: "1 to 2 sessions each", kind: "owner" }] },
          { label: "Same, at a distance through the pilot", note: "needs gate G-H4 passed", bars: [{ from: 3, to: 4, label: "Remote sessions", kind: "owner" }] },
          { label: "One real window on a friend's machine", note: "needs real signing and a separate ruling", bars: [{ from: 4, to: 4, label: "Needs signing", kind: "build" }] }
        ] },
        { id: "D", title: "Business, signing and the installer", rows: [
          { label: "Company, ABN, Microsoft tenant, signing", note: "your acts; Microsoft validation takes weeks and may fail", bars: [{ from: 0, to: 3, label: "Register, validate, buy signing", kind: "owner" }] },
          { label: "One signed installer from the plane", note: "25 to 38 Engineer days, mostly after the pilot", bars: [{ from: 3, to: 5, label: "Build, then trial sittings", kind: "build" }] }
        ] },
        { id: "E", title: "Unattended mode", rows: [
          { label: "Admin tier release, then policy mode (U1)", note: "about 6 to 8 weeks then about 28 Engineer days", bars: [{ from: 3, to: 6, label: "Build and review", kind: "build" }] },
          { label: "Your own test VM, then a friend's server", note: "virtualization is off in your firmware today", bars: [{ from: 7, to: 8, label: "VM sittings, then friend", kind: "owner" }] }
        ] },
        { id: "F", title: "Linux and macOS (new product lines)", rows: [
          { label: "Feasibility notes and spikes", note: "design only until Windows passes Gate B and the pilot", bars: [{ from: 1, to: 3, label: "Notes and spikes", kind: "dash" }] },
          { label: "Linux desktop (X11)", note: "45 to 70 Engineer days; Wayland adds 15 to 25", bars: [{ from: 5, to: 7, label: "Build and sittings", kind: "build" }] },
          { label: "macOS", note: "55 to 85 Engineer days; needs a Mac and an Apple developer account", bars: [{ from: 8, to: 10, label: "Build and sittings", kind: "build" }] }
        ] },
        { id: "G", title: "Before real customers", rows: [
          { label: "Penetration test, solicitor, insurance", note: "gates G-H5 and G-H6", bars: [{ from: 7, to: 12, label: "Scope, commission, fix", kind: "owner" }] }
        ] }
      ]
    },

    sittingsNote: "A sitting is an evening with both computers and Security's gates. An act is a short task of yours, such as an approval, a purchase or a copy. About 25 evenings fall before the end of September 2027, not counting the Linux and macOS ones.",
    sittings: [
      { n: "1", kind: "sitting", when: "about Jan 2027", date: "2027-01-15", approx: true, lead: "Flow test, evening 1: install and Observe drills.", what: "Install the build with Setup (no org key in this first flow), then the Observe drills with a short Part R. Replaces the staged sitting you cancelled on 23 Nov; every safety row of the old sheet is kept.", length: "85 to 90 min (estimate)", depends: "Setup slice 0 built and read; Security's installed-bytes gate and dry run; a new flow sheet; your by-name approval of the strings, the part-list hashes and a sentence, plus approvals A and B." },
      { n: "1a", kind: "sitting", when: "after evening 1", lead: "Flow test, evening 2: Enforce drills.", what: "Touch by mouse, button and key ends control; the chord is shown. Uninstall comes only at the end of the last sitting.", length: "70 to 75 min (estimate)", depends: "Security writes G6 good after reading evening 1; his G8 before each touch stop." },
      { n: "1b", kind: "act", you: true, when: "when asked", what: "Type your own sentence approving pilot terms 1 to 8 (yes to 1, 2, 3, 4, 5, 7, 8 and no to term 6). The file and the sentence shape are ready; nothing else is approved by it.", length: "5 min", depends: "Needed before the first tenancy and before the VPS configuration is approved." },
      { n: "2", kind: "sitting", when: "Feb", what: "Remaining stop paths and hostile cases on the test pad, then the time limit, a lapse with Enforce on, and Forget.", length: "about 3 h", depends: "Gate B." },
      { n: "3", kind: "act", you: true, when: "Jan to Feb", what: "Buy the Rackmill VPS as late as possible (after G-H2, before G-H3a), with its own static IPv4 and SSH key at creation; send Security the plan description first. Create the DNS record for control.flickerpane.com last, on Security's go.", length: "short", depends: "Back End's setup sheet draft 10; Security's go." },
      { n: "4", kind: "act", you: true, when: "Jan", what: "Buy two hardware keys and register both (ES256 FIDO2 with a PIN, never synced) so Back End can capture test vectors; hardware-key sign-in on Cloudflare too.", length: "30 to 60 min", depends: "Slice 3 spec (doc 87)." },
      { n: "5", kind: "act", you: true, when: "Jan", what: "By-name approval to download the Linux packages; create the VPS only after Security's G-H2; approve the exact first configuration (only SSH listening), then the second.", length: "about 1 h each", depends: "Slices 1 and 2 read; Linux script read." },
      { n: "6", kind: "sitting", when: "late Jan to Feb 2027", lead: "Pilot sitting(s).", what: "A test organisation on your own two computers through the relay and the hosted plane.", length: "1 to 2 evenings", depends: "Gates G-H3b, device pilot builds (relay wiring in the agent and controller, test flavour)." },
      { n: "7", kind: "sitting", when: "Dec to Feb", lead: "Friends, scratch pad only.", what: "Named friends (at most two), per person and per build hash, you present, written consent from each, undo at the end.", length: "1 to 2 each", depends: "Gate B, Security's separate request, then the pilot for friends at a distance." },
      { n: "8", kind: "sitting", when: "Jan to Feb", lead: "Real window and managed live.", what: "Two sittings.", length: "2 evenings", depends: "S2 and S3 built and read." },
      { n: "9", kind: "sitting", when: "Feb to Mar", lead: "Relay and live over relay.", what: "A desk test with no one at the laptop, then the two machines through a relay, then the live agent over it, then a second live round.", length: "3 to 4 evenings", depends: "S6 built and read." },
      { n: "10", kind: "sitting", when: "Mar", lead: "Viewer.", what: "Seeing the other screen, then over the relay.", length: "2 evenings", depends: "S4 built and read." },
      { n: "11", kind: "sitting", when: "Mar to Apr", lead: "Installer trial.", what: "One signed installer for the agent and controller, downloaded from the plane, tied to the company by a code.", length: "1 to 2 evenings", depends: "Signing in place." },
      { n: "12", kind: "sitting", when: "Mar", lead: "Admin tier release sittings.", what: "", length: "1 to 2 evenings", depends: "Tier A built and read." },
      { n: "13", kind: "sitting", when: "Jun to Jul", lead: "Unattended.", what: "Two or three sittings on your own test VM, then one or two on a friend's server. Your single-key risk acceptance is restated by name at the build approval.", length: "3 to 5 evenings", depends: "Gate B, S2, S6, Tier A, policy mode built; virtualization turned on." },
      { n: "14", kind: "sitting", when: "Jun to Sep", lead: "Linux desktop, then macOS.", what: "A spike you run read-only, then Observe and Enforce sittings for each.", length: "5 to 6 evenings", depends: "Windows through the pilot; each platform's own Security design." },
      { n: "15", kind: "act", you: true, when: "mid 2027", what: "Commission and scope the penetration test; sign off legal terms and insurance.", length: "weeks of elapsed time", depends: "A stable pilot." }
    ],

    costsNote: "What could be verified is marked verified. Figures taken from the Back End or Security documents are marked doc. Everything else is a rough estimate and must be checked against a quote or the provider's price page before you spend. This is general information, not financial or legal advice.",
    costs: [
      { item: "ABN", when: "Now", cost: "0", basis: [{ tag: "est", text: "Free from the Australian Business Register." }] },
      { item: "Company registration (ASIC)", when: "Now", cost: "about 600", basis: [{ tag: "est", text: "ASIC changes the fee each 1 July; confirm on their site." }] },
      { item: "Business name registration", when: "Now", cost: "about 45 (1 yr) or 105 (3 yr)", basis: [{ tag: "est", text: "Confirm with ASIC." }] },
      { item: "Accountant: structure, GST, setup", when: "Now", cost: "500 to 1,500", basis: [{ tag: "est", text: "" }] },
      { item: "D-U-N-S number, new Microsoft tenant", when: "Dec", cost: "0", basis: [{ tag: "est", text: "Free; Entra's free tier covers a tenant with no mailboxes." }] },
      { item: "Two hardware security keys (FIDO2)", when: "Dec", cost: "150 to 200 for two", basis: [{ tag: "est", text: "Security accepted Windows Hello on a TPM for the pilot with one more device, so this can be less." }] },
      { item: "VPS at Rackmill (2 vCPU, 4 GB, 40 GB, own static IPv4, plain image)", when: "buy late, after G-H2", cost: "price not checked", basis: [{ tag: "doc", text: "Spec from Back End doc 91 and Security's purchase checklist." }, { tag: "est", text: "You chose Rackmill and the size; I have not seen its plan prices. Send Security the plan description before buying." }] },
      { item: "Domain flickerpane.com (registered)", when: "done", cost: "paid by you; yearly renewal", basis: [{ tag: "est", text: "DNS at Cloudflare. The control plane is control.flickerpane.com; the bare domain is the public website, hosted elsewhere." }] },
      { item: "Code signing: OV certificate", when: "Feb", cost: "230 to 450 a year (US$150 to 300)", basis: [{ tag: "ver", text: "Microsoft's code-signing options page gives US$150 to 300 a year. Since 1 March 2026 third-party certificates last at most 460 days." }] },
      { item: "Code signing: Azure Artifact Signing", when: "Feb", cost: "price not confirmed", basis: [{ tag: "ver", text: "Needs a paid Azure subscription and identity checks. Australia looks supported but the three-year-history rule is unclear." }] },
      { item: "Business email on your own domain", when: "optional", cost: "10 to 15 per user a month", basis: [{ tag: "est", text: "" }] },
      { item: "Windows Server test VM", when: "spring", cost: "0", basis: [{ tag: "est", text: "Microsoft's 180-day evaluation edition; needs virtualization switched on in your firmware." }] },
      { item: "Solicitor: terms, privacy, tester consent", when: "before real customers", cost: "2,000 to 6,000", basis: [{ tag: "est", text: "Security leaves the legal side to you." }] },
      { item: "Insurance: professional indemnity and cyber", when: "before real customers", cost: "1,500 to 5,000 a year", basis: [{ tag: "est", text: "" }] },
      { item: "Penetration test of the hosted plane and VPS", when: "mid 2027", cost: "10,000 to 30,000", basis: [{ tag: "est", text: "Get at least two quotes. Required by Security's order before real tenants." }] },
      { item: "External Windows-internals review (headless sign-in screen)", when: "2028 or later", cost: "unknown", basis: [{ tag: "doc", text: "Back End doc 38 lists it; no price exists." }] },
      { item: "Apple developer account and a Mac, for macOS only", when: "mid 2027", cost: "150 a year plus 1,000 to 2,500 for the Mac", basis: [{ tag: "est", text: "Apple's US$99 a year; the Mac is needed to build and test." }] },
      { item: "Engineer, Security, Back End and PM sessions", when: "throughout", cost: "no separate cash cost known", basis: [{ text: "They run on your Claude plan. I do not know your plan's price or its usage limits, which may slow the work." }] }
    ],
    scenarios: [
      { label: "Pilot plus named friends, unsigned", value: "about 350 to 800", note: "First year. Keys, VPS and snapshots, domain renewals. No company needed." },
      { label: "Add the company and signing", value: "+ 1,200 to 3,500", note: "First year. Needed for any friend at real-input stage and for the one signed installer." },
      { label: "Add real customers", value: "+ 13,500 to 41,000", note: "One-off: solicitor, penetration test and the first year of insurance." },
      { label: "Add macOS", value: "+ 1,200 to 2,700", note: "One-off plus the first year's developer fee." }
    ],
    assumptions: [
      "Engineering days come from Back End's estimates of 22 November, each marked plus or minus 40% to 50%. Two Engineers cut the pilot from about 33 days to about 21, including 8 to 12 days of wiring the relay libraries into the agent and controller (Back End doc 91 rev 3); the slices that depend on each other still run one after another.",
      "Security reads about 1,000 lines an hour. The work needs about 12 reads in series before the pilot and another dozen for each later stage.",
      "A failed sitting costs about a week. The 22 November sitting stopped at the first hand-off, so a second round is a real possibility. The staged sitting of build 0.0.4.3 was cancelled on 23 November; its cleared files stay on disk for that build only.",
      "Setup slice 0 and the flow test times are Back End's unmeasured estimates (13 to 19 Engineer days for one Engineer, 9 to 14 with two). The installer is built from the 0.0.4.3 lineage, not main, and is not run until Security's gates and your by-name approval. The typed org key cannot be part of the first flow test, because there is no hosted plane yet to redeem it.",
      "An RDP forward through the relay counts as unattended access, so that shortcut is parked. Linux, macOS and the sign-in screen are design only until Windows passes Gate B and the hosted pilot. Their figures are low confidence.",
      "The unsigned exception for friends covers a scratch-pad test with no real input. Anything that types into a friend's real window needs real signing.",
      "December and January may slow down if you are away. I have not added any holiday time."
    ]
  };

  var data = { projects: [remoteLayout] };

  if (typeof module !== "undefined" && module.exports) module.exports = data;
  else root.BarnyardProjectsData = data;
})(typeof window !== "undefined" ? window : this);
