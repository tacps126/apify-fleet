# Security

Please report vulnerabilities privately through GitHub: the repository's Security tab,
"Report a vulnerability". Do not open a public issue.

Things we care about most:

- the API token reaching output, logs, error messages or any host other than the Apify API;
- a command changing or deleting something without `--apply`, or outside the selected Actors;
- `clean` deleting a tagged build, an unfinished run or build, or a storage that does not match
  `--match`.

We aim to answer within a week.
