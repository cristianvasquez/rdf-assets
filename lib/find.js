import { glob } from 'glob'

async function applyGlob (globPattern) {
  const files = await glob(globPattern, {
    stat: true, nodir: true,
  })

  if (files.length === 0) {
    console.log('No files found')
    console.log({ workingDir: process.cwd(), globPattern })
  } else {
    console.log(files.length, 'files from', globPattern)
  }
  return files
}

export { applyGlob }
