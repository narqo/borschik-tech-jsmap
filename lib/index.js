var fs = require('fs'),
    path = require('path'),
    map = require('./sourcemap');

function commentsWrap(content, file) {
    return '/* ' + file + ' begin */\n' +
        content +
        '\n/* ' + file + ' end */\n';
}

function countLines(content) {
    return content.split('\n').length - 1;
}

module.exports = function(borschik) {
    var jsTech = borschik.getTech('js'),
        Tech, File;

    File = jsTech.File.inherit({

        __constructor : function() {
            this.__base.apply(this, arguments);
            this.map = new map.SourceMap(this);
        },

        read : function() {
            var content = fs.readFileSync(this.processPath(this.path));

            this.content = this.parse(content);
            this.map.createSource(this.path, content);

            return this;
        },

        addMapping : function() {
            this.map.addMapping.apply(this.map, arguments);
        },

        combineMaps : function(map, offset, isJsonStringified) {
            this.map.combine(map, offset, isJsonStringified);
        },

        parseInclude : function(content) {
            var _this = this;

            if(Buffer.isBuffer(content)) {
                content = content.toString('utf8');
            }

            var includes = [],
                uniqStr = '\00borschik\00',
                allIncRe = new RegExp([
                        ['\\{/\\*!?', '\\*/\\}'],
                        ['\\[/\\*!?', '\\*/\\]'],
                        ['/\\*!?', '\\*/'],
                        ['[\'"]', '[\'"]']
                    ]
                    .map(function(i) {
                        return ['(?:', i[0], '\\s*borschik:include:(.*?)\\s*', i[1], ')'].join('');
                    })
                    .join('|')
                    + '|' +
                    // RegExp to find borschik.link("path/to/image.png")
                    'borschik\\.link\\([\'"]([^@][^"\']+?)[\'"]\\)',
                    'g'),
                texts = content
                    // finds /*borschik:include:*/ and "borschik:include:"
                    .replace(allIncRe,
                        function(match, incObjectFile, incArrayFile, incCommFile, incStrFile, borschikLink) {
                            var incFile = incObjectFile || incArrayFile || incCommFile || incStrFile;
                            if(incFile) {
                                includes.push({
                                    file : _this.pathTo(incFile),
                                    type : incStrFile ? 'include-json' : 'include-inline',
                                    content : match
                                });
                            } else {
                                includes.push({
                                    file : _this.pathTo(borschikLink),
                                    type : 'link-url',
                                    content : match
                                });
                            }
                            return uniqStr;
                    })
                    .split(uniqStr);

            // zip texts and includes
            var res = [], t, i;
            while((t = texts.shift()) != null) {
                t && res.push(t);
                (i = includes.shift()) && res.push(i);
            }

            return res;
        },

        processInclude : function(baseFile, content) {
            var parsed = content || this.content,
                mapPath = this.path,
                original = {
                    line : 1,
                    column : 0
                },
                generated = {
                    line : 1,
                    column : 0
                },
                line, column;

            function moveCursor(content, cursor) {
                var lines = content.split('\n');

                cursor.line += lines.length - 1;

                var lastLine = lines.pop();
                if (lines.length) {
                    cursor.column = lastLine.length;
                } else {
                    cursor.column += lastLine.length;
                }

                return cursor;
            }

            var item, processed;
            for(var i = 0; i < parsed.length; i++) {
                item = parsed[i];

                line = generated.line;
                column = generated.column;

                if(typeof item === 'string') {
                    this.addMapping(mapPath, line, column, original.line, original.column, item);

                    moveCursor(item, original);
                    moveCursor(item, generated);

                    continue;
                }

                if(item.type === 'link-url') {
                    // freeze images with cssBase.processLink
                    parsed[i] = this.child(item.type, item.file).process(baseFile);

                    this.addMapping(mapPath, line, column, original.line, original.column, parsed[i]);

                    moveCursor(parsed[i], generated);
                    moveCursor(item.content, original);

                    continue;
                }

                if(!fs.existsSync(item.file)) {
                    throw new Error('File ' + item.file + ' does not exists, base file is ' + baseFile);
                }

                var child = this.child('include', item.file),
                    result;

                processed = child.process(baseFile);

                if(item.type === 'include-inline') {
                    if (this.tech.opts.comments) {
                        result = commentsWrap(processed, path.relative(path.dirname(baseFile), item.file));
                        // comment "begin"
                        ++line;
                        // this makes sense only if comments inserted
                        column = 0;
                    } else {
                        result = processed;
                    }

                    // NOTE: reduce `line` offset with 1,
                    // because we're replacing content of `include`-token,
                    // not adding new one
                    this.combineMaps(child.map, { line: line - 1, column: column });
                } else {
                    result = JSON.stringify(processed);
                    this.combineMaps(child.map, { line: line - 1, column: column }, true);
                }

                parsed[i] = result;

                moveCursor(result, generated);
                moveCursor(item.content, original);
            }

            return parsed.join('');
        }
    });

    Tech = jsTech.Tech.inherit({

        File : File,

        process : function(path, out) {
            var file = this.createFile(path, 'include'),
                map = file.map,
                res = file.process(path);

            if(this.opts.minimize) {
                res = this.minimize(res, map);
            }

            if(map) {
                res = this.sourcemap(res, map, out);
            }

            return this.write(out, res);
        },

        sourcemap : function(content, map, out) {
            if(typeof out === 'undefined') {
                return content;
            }

            if(typeof out !== 'string' && out.path) {
                out = out.path;
            }

            var outName = path.basename(out),
                outRoot = path.dirname(out),
                mapName = outName + '.map';

            return this.write(
                    path.join(outRoot, mapName), map.generate(outName, outRoot).toString())
                .then(function() {
                    return content + '\n//# sourceMappingURL=' + mapName;
                });
        }
    });

    return {
        File : File,
        Tech : Tech
    };
};
