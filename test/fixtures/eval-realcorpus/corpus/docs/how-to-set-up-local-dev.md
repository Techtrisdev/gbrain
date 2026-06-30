# How to set up your local development environment

Get a working local stack so you can run the test suite and the app before your first
commit.

1. Install the runtime (Bun) and the database (Postgres) using the versions pinned in
   the repository's tool-versions file.
2. Copy `.env.example` to `.env` and fill in local values. Real credentials live in the
   secrets manager; the example file ships safe placeholders only.
3. Run the database migrations, then seed the local database with the sample fixtures.
4. Start the dev server and confirm the health check returns OK.
5. Run the unit tests once to verify the toolchain — a green suite means your machine
   matches CI.
