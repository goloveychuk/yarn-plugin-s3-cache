#!/usr/bin/env node
import { checkbox, input } from '@inquirer/prompts'
import * as path from 'path'
import * as fs from 'fs';
import * as esbuild from 'esbuild'

import { execa } from 'execa'

import { fileURLToPath } from 'url';
const cwd = process.cwd()

const pluginDir = path.join(cwd, '.yarn/plugins/@yarnpkg/')

const dirname = path.dirname(fileURLToPath(import.meta.url))


const distDir = path.join(dirname, 'bundles/@yarnpkg')



const helpersOptions = fs.readdirSync(distDir).filter(f => f.includes('.helper'))


const helpers = await checkbox<string>({
    message: 'Select platforms and architectures you want to run cache on',
    required: true,
    validate: (input) => {
        if (input.length == 0) {
            return 'You must select at least one platform and architecture'
        }
        return true
    },
    choices: helpersOptions.map((helper) => {
        return {
            name: helper.replace('plugin-s3-cache.helper-', ''),
            value: helper
        }
    })
})

async function bundle(input: string) {
    const result = await esbuild.build({
        entryPoints: [input],
        bundle: true,
        platform: 'node',
        minify: false,
        target: 'node18',
        format: 'cjs',
        write: false,
    })
    if (result.errors.length > 0) {
        const formatted = await esbuild.formatMessages(result.errors, { kind: 'error' })
        throw new Error(formatted.join('\n'))
    }
    return result.outputFiles[0].text
}

const defaultConfPath = 'cache-plugin.config.mts'
if (!fs.existsSync(defaultConfPath)) {
    await fs.promises.copyFile(path.join(dirname, 'template.mts'), defaultConfPath)
}

const confPath = await input({
    message: 'Enter path to file which exports config module. You should edit template',
    required: true,
    default: defaultConfPath,
    transformer: (input, {isFinal}) => {
        if (isFinal) {
            return path.resolve(input)
        }
        return input
    },
    validate: async (input) => {
        if (!input) {
            return 'Path is required'
        }
        const p = path.resolve(input)
        if (!fs.existsSync(p)) {
            return `File ${p} does not exist`
        }
        try {
            await bundle(input)
        } catch (e) {
            return `Error when bundling ${p}:\n${e}`
        }

        return true
    }
})


async function install() {
    await execa('yarn', ['plugin', 'import', path.join(distDir, 'plugin-s3-cache.js')], { stdio: 'inherit' })
    for (const helper of helpers) {
        const helperPath = path.join(distDir, helper);
        const helperDistPath = path.join(pluginDir, helper)
        await fs.promises.copyFile(helperPath, helperDistPath)
    }
    const conf = await bundle(confPath)
    await fs.promises.writeFile(path.join(pluginDir, 'plugin-s3-cache.config.cjs'), conf, 'utf8')
}

await install()