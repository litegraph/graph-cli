const asc = require('assemblyscript/cli/asc')
const chalk = require('chalk')
const fs = require('fs-extra')
const path = require('path')

const DataSource = require('./data-source')
const Logger = require('./logger')
const TypeGenerator = require('./type-generator')

class Compiler {
  constructor(options) {
    this.options = options
    this.sourceDir = path.dirname(options.dataSourceFile)
    this.logger = new Logger(10)
  }

  compile() {
    let dataSource = this.loadDataSource()
    let buildDir = this.createBuildDirectory()
    let dataSourceInBuildDir = this.copyDataSource(dataSource, buildDir)
    let typeFiles = this.generateTypes(dataSourceInBuildDir, buildDir)
    this.copyRuntimeFiles(buildDir)
    this.addTypesToRuntime(buildDir, typeFiles)
    this.addMappingToRuntime(buildDir)
    this.createOutputDirectory()

    let compiledDataSource = this.compileDataSource(dataSourceInBuildDir, buildDir)

    let finalDataSource = this.writeDataSourceToOutputDirectory(
      compiledDataSource,
      buildDir
    )
  }

  loadDataSource() {
    try {
      this.logger.step('Load data source:', this.options.dataSourceFile)
      return DataSource.load(this.options.dataSourceFile)
    } catch (e) {
      this.logger.fatal('Failed to load data source:', e)
    }
  }

  createBuildDirectory() {
    try {
      this.logger.step('Create build directory')

      // Create temporary directory
      let buildDir = fs.mkdtempSync('.the-graph-wasm')

      // Ensure the temporary directory is destroyed on exit
      process.on('exit', () => fs.removeSync(buildDir))
      process.on('SIGINT', () => fs.removeSync(buildDir))
      process.on('uncaughtException', () => fs.removeSync(buildDir))

      return buildDir
    } catch (e) {
      this.logger.fatal('Failed to create build directory:', e)
    }
  }

  copyDataSource(dataSource, buildDir) {
    try {
      this.logger.step('Copy data source to build directory')

      // Copy schema and update its path
      dataSource = dataSource.updateIn(['schema', 'source', 'path'], schemaPath =>
        this._copyDataSourceFile(schemaPath, this.sourceDir, buildDir)
      )

      // Copy data set files and update their paths
      dataSource = dataSource.updateIn(['datasets'], dataSets => {
        return dataSets.map(dataSet =>
          dataSet
            .updateIn(['mapping', 'abis'], abis =>
              abis.map(abi =>
                abi.updateIn(['source', 'path'], abiPath =>
                  this._copyDataSourceFile(abiPath, this.sourceDir, buildDir)
                )
              )
            )
            .updateIn(['mapping', 'source', 'path'], mappingPath =>
              this._copyDataSourceFile(mappingPath, this.sourceDir, buildDir)
            )
        )
      })

      return dataSource
    } catch (e) {
      this.logger.fatal('Failed to copy data source files:', e)
    }
  }

  _copyDataSourceFile(maybeRelativeFile, sourceDir, targetDir) {
    let absoluteSourceFile = path.resolve(sourceDir, maybeRelativeFile)
    let relativeSourceFile = path.relative(sourceDir, absoluteSourceFile)
    let targetFile = path.join(targetDir, relativeSourceFile)
    this.logger.note('Copy data source file:', relativeSourceFile)
    fs.mkdirsSync(path.dirname(targetFile))
    fs.copyFileSync(absoluteSourceFile, targetFile)
    return targetFile
  }

  generateTypes(dataSource, buildDir) {
    this.logger.step('Generate types from contract ABIs')

    let generator = new TypeGenerator({
      dataSource,
      outputDir: buildDir,
      logger: {
        prefix: '.....',
      },
    })
    return generator.generateTypes()
  }

  copyRuntimeFiles(buildDir) {
    this.logger.step('Copy runtime to build directory')
    this._copyRuntimeFile(buildDir, 'index.ts')
  }

  _copyRuntimeFile(buildDir, basename) {
    this.logger.note('Copy runtime file:', basename)
    fs.copyFileSync(
      path.join(__dirname, '..', 'src', basename),
      path.join(buildDir, basename)
    )
  }

  addTypesToRuntime(buildDir, typeFiles) {
    this.logger.step('Add generated types to runtime')
    try {
      typeFiles.forEach(typeFile => {
        this.logger.note(
          'Add types from file to runtime:',
          path.relative(buildDir, typeFile)
        )

        let types = fs.readFileSync(typeFile)
        fs.appendFileSync(path.join(buildDir, 'index.ts'), types + '\n', 'utf-8')
      })
    } catch (e) {
      this.logger.fatal('Failed to add types to runtime:', e)
    }
  }

  addMappingToRuntime(buildDir) {
    this.logger.step('Add mapping to runtime')
    try {
      let mapping = fs.readFileSync(path.join(buildDir, 'mapping.ts'))
      fs.appendFileSync(path.join(buildDir, 'index.ts'), mapping, 'utf-8')
    } catch (e) {
      this.logger.fatal('Failed to add mapping to runtime:', e)
    }
  }

  createOutputDirectory() {
    try {
      this.logger.step('Create output directory:', this.options.outputDir)
      fs.mkdirsSync(this.options.outputDir)
    } catch (e) {
      this.logger.fatal('Failed to create output directory:', e)
    }
  }

  compileDataSource(dataSource, buildDir) {
    try {
      this.logger.step('Compile data source')

      dataSource = dataSource.updateIn(['datasets'], dataSets =>
        dataSets.map(dataSet =>
          dataSet.updateIn(['mapping', 'source', 'path'], mappingPath =>
            this._compileDataSetMapping(dataSet, mappingPath, buildDir)
          )
        )
      )

      return dataSource
    } catch (e) {
      this.logger.fatal('Failed to compile data source:', e)
    }
  }

  _compileDataSetMapping(dataSet, mappingPath, buildDir) {
    try {
      let dataSetName = dataSet.getIn(['data', 'name'])

      this.logger.note(
        'Compile data set mapping:',
        dataSetName,
        '/',
        path.relative(buildDir, mappingPath)
      )

      let outputFile =
        this.options.outputFormat == 'wasm'
          ? `${dataSetName}.wasm`
          : `${dataSetName}.wast`

      asc.main(
        ['--baseDir', buildDir, '--outFile', outputFile, 'index.ts'],
        {
          stdout: process.stdout,
          stderr: process.stdout,
        },
        e => {
          if (e != null) {
            this.logger.fatal('Failed to compile data set mapping:', e)
          }
        }
      )

      return path.join(buildDir, outputFile)
    } catch (e) {
      this.logger.fatal('Failed to compile data set mapping:', e)
    }
  }

  writeDataSourceToOutputDirectory(dataSource, buildDir) {
    try {
      this.logger.step('Write compiled data source to output directory')

      // Copy schema and update its path
      dataSource = dataSource.updateIn(['schema', 'source', 'path'], schemaPath =>
        path.relative(
          this.options.outputDir,
          this._copyDataSourceFile(
            path.relative(buildDir, schemaPath),
            buildDir,
            this.options.outputDir
          )
        )
      )

      // Copy data set files and update their paths
      dataSource = dataSource.updateIn(['datasets'], dataSets => {
        return dataSets.map(dataSet =>
          dataSet
            .updateIn(['mapping', 'abis'], abis =>
              abis.map(abi =>
                abi.updateIn(['source', 'path'], abiPath =>
                  path.relative(
                    this.options.outputDir,
                    this._copyDataSourceFile(
                      path.relative(buildDir, abiPath),
                      buildDir,
                      this.options.outputDir
                    )
                  )
                )
              )
            )
            .updateIn(['mapping', 'source', 'path'], mappingPath =>
              path.relative(
                this.options.outputDir,
                this._copyDataSourceFile(
                  path.relative(buildDir, mappingPath),
                  buildDir,
                  this.options.outputDir
                )
              )
            )
        )
      })

      // Write the generated index.ts (for debugging purposes)
      this.logger.note('Write generated AssemblyScript source:', 'index.ts')
      fs.copyFileSync(
        path.join(buildDir, 'index.ts'),
        path.join(this.options.outputDir, 'index.ts')
      )

      // Write the data source definition itself
      let outputFilename = path.join(this.options.outputDir, 'data-source.yaml')
      this.logger.note('Write data source definition:', path.basename(outputFilename))
      DataSource.write(dataSource, outputFilename)

      return dataSource
    } catch (e) {
      this.logger.fatal('Failed to write compiled data source to output directory:', e)
    }
  }
}

module.exports = Compiler
