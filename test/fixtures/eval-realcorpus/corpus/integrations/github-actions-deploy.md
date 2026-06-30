# Integration: set up the GitHub Actions deploy workflow

Automate deploys so a merge to the main branch ships to production after tests pass.

1. Add a workflow file under `.github/workflows/deploy.yml` triggered on `push` to `main`.
2. Store deploy credentials as repository secrets (never inline them in the YAML) and
   reference them with `${{ secrets.DEPLOY_TOKEN }}`.
3. Structure the jobs so tests run first and the deploy job declares `needs: test` — a
   red test suite must block the deploy.
4. Pin third-party actions to a commit SHA, not a floating tag, so a compromised tag
   can't inject code into your pipeline.
5. Add a manual `workflow_dispatch` trigger for emergency redeploys without a new commit.
