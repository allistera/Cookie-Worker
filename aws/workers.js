// The Workers the Lambda Web Function serves, each on the hostname CloudFront forwards in
// x-forwarded-host. scripts/build-aws.mjs bundles every Worker listed here with the vars from its
// wrangler.jsonc. `secrets` names what the revision's environment must provide, which
// .github/workflows/deploy-aws.yml writes from GitHub secrets; every Worker also gets DATABASE_URL in
// place of its Hyperdrive binding. README.md, "AWS Web Function", lists the steps to move one.
export const AWS_WORKERS = [
  {
    name: 'cookie-web-receipts',
    hostname: 'receipts-api.infinitywave.online',
    secrets: ['SENTRY_DSN'],
  },
];
