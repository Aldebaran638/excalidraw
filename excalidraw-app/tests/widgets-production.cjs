// The same acceptance journey must work without development globals.
process.env.APP_URL ||= "http://127.0.0.1:3102";
process.env.TEST_NOTES_DIR ||= "skip";
require("./widgets-redesign.cjs");
