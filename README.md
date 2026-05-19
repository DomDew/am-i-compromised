# am-i-compromised

Supply-chain attacks are everywhere lately. This is a small script to check whether any of the compromised packages from a [Socket.dev vulnerability report](https://socket.dev/blog/antv-packages-compromised#Affected-Packages) - or any similar CSV - are installed in your Node project.

## Installation

From inside this directory, install it globally with npm:

```bash
npm install -g .
```

This registers the `am-i-compromised` command in your PATH (works in both bash and zsh). After that you can run it from anywhere:

```bash
am-i-compromised vulnerabilities.csv /path/to/project/package-lock.json
```

To uninstall:

```bash
npm uninstall -g am-i-compromised
```

If you'd rather not install globally, just run it with `node check.js` directly (see below).

## Usage

```bash
node check.js <csv-file> [package-lock.json] [package.json]
```

The last two arguments default to `./package-lock.json` and `./package.json`.

### Examples

```bash
# Check the current project
node check.js vulnerabilities.csv

# Check another project
node check.js vulnerabilities.csv ~/projects/my-app/package-lock.json ~/projects/my-app/package.json
```

## CSV Format

The CSV must have a header row with these columns (order doesn't matter):

| Column      | Used | Notes                                                    |
| ----------- | ---- | -------------------------------------------------------- |
| `ecosystem` | ✓    | Only `npm` / `node` rows are checked; others are skipped |
| `namespace` | ✓    | Scoped package prefix, e.g. `@babel`                     |
| `name`      | ✓    | Package name, e.g. `core`                                |
| `version`   | ✓    | Exact version to look for, e.g. `7.0.0`                  |
| `published` | —    | Shown in output on a match                               |
| `detected`  | —    | Shown in output on a match                               |

`namespace` + `name` are combined to form the full package name:

- `@babel` + `core` → `@babel/core`
- _(empty)_ + `lodash` → `lodash`

## Matching

Versions are matched **exactly** against the resolved version recorded in `package-lock.json`. Lockfile versions 1, 2, and 3 are all supported.

`package.json` is also checked for cases where no lockfile is present, but note that `package.json` typically contains version ranges (`^1.2.3`) rather than resolved versions, so exact matches there are less common.

## Exit Codes

| Code | Meaning                            |
| ---- | ---------------------------------- |
| `0`  | No matches — project appears clean |
| `1`  | One or more flagged versions found |

This makes the script usable in CI pipelines:

```bash
node check.js vulns.csv package-lock.json && echo "Clean"
```

## Output Example

```
============================================================
  am-i-compromised
  CSV:  /tmp/vulns.csv
  Lock: /project/package-lock.json  (lockfileVersion 3)
  Pkg:  /project/package.json
============================================================

⚠  1 MATCH(ES) FOUND:

  PACKAGE : @babel/core@7.0.0
  Published: 2022-01-15
  Detected : 2022-03-10
  Found in : lockfile

------------------------------------------------------------
  2 flagged package(s) NOT found in this project:

  lodash@4.17.15  (installed: 4.17.21)
  semver@5.6.0

============================================================
  Summary: 1 match(es) / 3 checked
============================================================
```
