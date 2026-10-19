# Governance

Tyler Kendrick ([@Tyler-R-Kendrick](https://github.com/Tyler-R-Kendrick)) is
the sole maintainer of this repository, and its BDFL (benevolent dictator for
life). The project has no foundation, company, or committee.

## Decisions

The maintainer decides what lands on `main`, what the public API is, and what
these community documents say. Discussion happens on issues and pull requests.
A change is accepted when the maintainer merges it. When a refusal is not
already explained by the review, the maintainer says why.

Constraints already written in [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md) are the default. Breaking one of them requires an
explicit decision from the maintainer, recorded on the pull request.

## Commit access

Nobody else has a standing vote. The maintainer may grant commit access to a
contributor with a history of reviewed, merged changes who follows
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and the contribution rules. The
maintainer can revoke that access. Another maintainer is added only by naming
them in this file.

## Disputes

Raise a disagreement on the issue or pull request, or contact
[@Tyler-R-Kendrick](https://github.com/Tyler-R-Kendrick) on GitHub. The
maintainer's decision stands.

Conduct reports follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Vulnerability
reports follow [SECURITY.md](SECURITY.md).

## Releases

The maintainer tags releases from `main` and publishes packages from that
commit. There is no release calendar. Inside a release,
changes stay additive and deprecated aliases keep working, as
[AGENTS.md](AGENTS.md) requires. Versions that accept security reports are
described in [SECURITY.md](SECURITY.md).

## Continuity

If the maintainer is unavailable, issues and pull requests can still be
opened, and no one else is authorized to merge or publish. This file names no
successor, and nothing here transfers that authority on its own. Continuity
then depends on GitHub account recovery, or on the maintainer updating this
file. The [MIT license](LICENSE) already allows anyone to fork and maintain a
separate copy. A fork is not a release of this repository.
