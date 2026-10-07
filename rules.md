There needs to be a clear road to production, even though nothing here needs to be production-ready


1. Resist the urge to add more than you need
You can generate a lot of code very quickly with AI tools now, that's completely fine and expected. But it's become the main way candidates trip themselves up. Extra scaffolding, an unrequested frontend, tooling nobody asked for, bells and whistles, these don't read as effort, they read as a lack of judgment about what the task actually needed. We'd much rather see something small and complete than something large and padded.
If you've got spare time, spend it proving what you've already built actually works, not adding new surface area.

2. Every claim in your README must survive someone actually running it
If you say you ran a type checker, it needs to be in your dependency list and actually pass, or be honest that it surfaces issues. If you claim a concurrency guarantee, don't just describe it, prove it with a test that fires real concurrent requests and would fail if the protection were removed. Anything you write down gets checked.

3. Don't write tests that can pass without testing anything
Avoid assertions sitting inside an if that might not trigger. Avoid assertions that accept multiple possible outcomes (e.g. "status code is either X or Y"), that reads as uncertainty about your own system, not a pinned contract. Every test should assert one specific, correct outcome, unconditionally.

4. Business rules need to be consistent everywhere they apply
If a rule exists (e.g. "no duplicate doors between the same two rooms"), it needs to be enforced the same way whether the data comes in via a bulk import endpoint or the normal API. Don't let one entry point be stricter than another for the same underlying rule.

5. Keep documentation proportional to the code, and don't bury your best insights
A few pages of clear, precise reasoning beats a huge write-up. If you've found something genuinely clever, make sure it's easy to find, not buried under volume.

6. If you use AI tooling, be specific and own it
Don't just say "AI was used throughout." Say what you decided yourself, and give one concrete example, a design you rejected, a bug you found and fixed after generation. Specific disclosure with evidence of your own judgment reads well, vague disclosure reads worse than none at all.

7. Concurrency and full completeness matter
Cover every mutation path  with the same rigor, don't leave one endpoint untested or unimplemented. If two things can happen at once, prove your protection actually works under real concurrent load, not just in theory

8. Size the work to a real building
State the resonably surface limit instead of designing for a building that does not exist.