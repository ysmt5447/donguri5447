// Explicit local-only mode: ignores DATABASE_URL and never writes user data.
process.env.LOCAL_TEST = '1';
require('./server.js');
