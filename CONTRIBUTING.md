# Contributing

Thanks for helping make NeverQuestAlone better. The README’s [Build your own](README.md#build-your-own) section says what this repository holds, and [Get started](docs/get-started.md) shows how to build and run it.

## How a pull request lands

We build NeverQuestAlone from a private repository, and each release copies its source here as one commit. So a pull request here isn’t merged here:

1. We review it here, as usual.
2. If we take it, we make your change in the private repository ourselves.
3. The next release’s commit here carries your change, with you as its co-author: the commit message ends with a `Co-authored-by:` line with your GitHub name and your GitHub noreply address, so GitHub credits you.
4. We close your pull request with a link to that commit.

## License

Everything you contribute is under the [MIT license](LICENSE), like the rest of this repository.

## Before you open one

- Run `npm ci` and `npm test`. The same tests run on every push and pull request here.
- Keep each pull request to one change, and say what it fixes.
- Never include an API key, even one you’ve deleted.
- Report a security problem privately on the Security tab (Report a vulnerability), never in a public issue or pull request.
