// A dependency update PR from a trusted bot carries no SBI Issue. Only that one requirement is lifted, and only when GitHub itself says
// the bot opened the PR and wrote every commit (the commit is signed by GitHub, so neither the author e-mail nor the PR body counts),
// the judged checkout is the PR head in this repository, and every changed file is an allowed dependency manifest or lockfile.
// Verifiers, Security, Risk and the Completion Judge are unchanged. Anything that cannot be confirmed keeps the SBI required.
export function judgeDependencyBot({ policy, files, pull, commits, headSha, repository }) {
  const reasons = [];
  const bot = policy.bots.find(b => b.login === pull.user?.login);
  if (!bot) reasons.push(`pull request author ${pull.user?.login ?? '(unknown)'} is not a trusted dependency bot`);
  else if (pull.user.type !== bot.type) reasons.push(`pull request author ${bot.login} is type ${pull.user.type ?? 'unknown'}, not ${bot.type}`);
  if (!pull.head?.repo) reasons.push('pull request head comes from a deleted fork');
  else if (pull.head.repo.full_name !== repository) reasons.push(`pull request head is in ${pull.head.repo.full_name}, not ${repository}`);
  if (pull.head?.sha !== headSha) reasons.push(`judged ${headSha} but the pull request head is ${pull.head?.sha ?? 'unknown'}`);
  if (!commits.length) reasons.push('pull request has no commit');
  for (const c of commits) {
    if (c.author?.login !== pull.user?.login) reasons.push(`commit author ${c.author?.login ?? '(not a GitHub account)'} is not the pull request bot`);
    if (c.commit.verification?.verified !== true) reasons.push('commit is not verified by GitHub');
  }
  if (!files.length) reasons.push('no changed file');
  for (const { path } of files) if (!policy.paths.includes(path)) reasons.push(`${path} is not an allowed dependency file`);
  return { exempt: reasons.length === 0, bot: reasons.length ? null : bot.login, reasons: [...new Set(reasons)] };
}

export async function dependencyBotExemption({ policy, files, headSha, repository, pullNumber, github }) {
  const denied = reason => ({ exempt: false, bot: null, reasons: [reason] });
  if (!/^[1-9]\d*$/.test(String(pullNumber ?? ''))) return denied('no pull request number to read the dependency bot PR');
  if (!repository) return denied('GITHUB_REPOSITORY is not set');
  const [owner, repo] = repository.split('/');
  try {
    const number = Number(pullNumber);
    const [pull, commits] = await Promise.all([github.fetchPull({ owner, repo }, number), github.pullCommits({ owner, repo }, number)]);
    return judgeDependencyBot({ policy, files, pull, commits, headSha, repository });
  } catch (error) { return denied(`dependency bot PR could not be read (${error.message})`); }
}
