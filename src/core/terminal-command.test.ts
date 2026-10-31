import { describe, expect, it } from 'vitest'
import { refusal, shellSyntaxError } from './terminal-command'

describe('run_in_terminal commands', () => {
  it('lets ordinary command lines through', () => {
    for (const line of [
      'npm run dev',
      'NODE_ENV=production npm run build && npm test || echo failed',
      `grep -rn "a #b" src | head -5`,
      "echo 'it!s quoted' > out.txt",
      '[ "$a" != b ] && echo different',
      'cat <<< "here-string"',
      'tail -f log/dev.log',
      'echo $HOME $PWD',
    ]) {
      expect(refusal(line), line).toBeNull()
    }
  })

  it('refuses lines that are not one complete, printable command', () => {
    expect(refusal('')).toContain('empty')
    expect(refusal('echo a\necho b')).toContain('more than one line')
    expect(refusal('echo é')).toContain('non-ASCII')
    expect(refusal('npm test |')).toContain('operator')
    expect(refusal('make && \\')).toContain('backslash')
    expect(refusal('cat <<EOF')).toContain('Here-documents')
  })

  it('refuses lines that reach into the shell itself', () => {
    expect(refusal('sudo !!')).toContain('history expansion')
    expect(refusal('echo hi # comment')).toContain('comment')
    expect(refusal('echo $_')).toContain('$_')
    expect(refusal('PS1="> "')).toContain('PS1')
    expect(refusal('export PROMPT_COMMAND=x')).toContain('PROMPT_COMMAND')
    expect(refusal('precmd() { echo x }')).toContain('precmd')
    expect(refusal("trap 'echo bye' EXIT")).toContain('trap')
    expect(refusal('history | tail')).toContain('history command')
    expect(refusal('fc -l')).toContain('history command')
  })

  it("finds what the user's shell cannot parse", async () => {
    expect(await shellSyntaxError('/bin/zsh', 'echo hi && ls')).toBeNull()
    expect(await shellSyntaxError('/bin/zsh', "echo 'unclosed")).toMatch(/unmatched|quote/)
    expect(await shellSyntaxError('/bin/zsh', 'if true; then echo x')).not.toBeNull()
  })
})
