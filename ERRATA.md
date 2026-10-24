# Errata

A test tool is only as useful as its error rate. When EmberTail gets something wrong, it is
corrected here and with the project concerned.

| Date         | What we got wrong                                                                                                                                      | Correction                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| October 2026 | We reported a double payment by Franklin (our scenario S40). It came from a bug in our own transcript extractor, not from Franklin. BlockRun found it. | Corrected with BlockRun; noted in the [Franklin 3.49.10 release notes](https://github.com/BlockRunAI/Franklin/releases/tag/v3.49.10). Our extractor was fixed. |

So far, every error in our own tooling has produced a false failure; none has hidden a real one.
We treat a reported failure as unproven until a control run and the project's own code confirm it.
