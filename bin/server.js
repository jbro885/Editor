const fs = require("fs");
//const https = require('https');
const http = require('http');
/*var options = {
  key: fs.readFileSync('keys/key.pem'),
  cert: fs.readFileSync('keys/cert.pem')
};*/
const url = require('url');
const hostname = '127.0.0.1';
const port = 3000;

const serverFile = "./server.elm"
const htaccessFile = "./htaccess.elm"

// Don't meodify, this will be bundled with the file server.elm
const defaultServerContent = "<html><head></head><body>Server not available.</body></html>";

const defaultHtAccessFileContent = `if Regex.matchIn """\\.\\.(?:/|\\\\)|(?:/|\\\\)\\.\\.|^\\.\\.$""" path then False else True`

function readServerFile() {
  if(fs.existsSync(serverFile)) {
    return fs.readFileSync(serverFile, "utf8");
  } else
    return defaultServerContent;
}

function readHtAccessFile() {
  if(fs.existsSync(htaccessFile)) {
    return fs.readFileSync(htaccessFile, "utf8");
  } else
    return defaultHtAccessFileContent;
}

const sns = require("sketch-n-sketch");
sns.params = sns.params || {};
sns.params.delayedWrite = true;
sns.fileOperations = sns.fileOperations || [];

function evaluateToHtml(name, env, source) {
  var result = sns.objEnv.string.evaluate(env)(source);
  if(result.ctor == "Ok") {
    var out = sns.valToHTMLSource(result._0)
    if(out.ctor == "Ok") {
      return out;
    } else {
      return { ctor: "Err", _0: "Error while converting the result to HTML source file: " + out._0}
    }
  } else {
    return { ctor: "Err", _0: `Error while interpreting ${name}: ` + result._0}
  }
}

function lazyListToList(ll) {
  var x = [];
  while(sns.lazyList.nonEmpty(ll)) {
    x.push(sns.lazyList.head(ll));
    ll = sns.lazyList.tail(ll);
  }
  return x;
}

cachedSolutions = {
  key: {
     timestamp: 0,
     computed: ["html page", "environment overrides", "fileOperations"],
     remaining: "lazyList of solutions. Call getOneSolution(this.name, this.source) on it to get one more solution",
     name: "The name that is being computed",
     source: "The source file of the server"
  }
}

function uniqueKey() {
  var potentialkey = 1000;
  while(typeof cachedSolutions[potentialkey] != "undefined") {
    potentialkey++;
  }
  return potentialkey;
}

function envToOverrides(env) { return env.vars; }

function getOneSolution(name, source, allSolutions) {
  if(sns.lazyList.isEmpty(allSolutions)) return false;
  var {_0: newEnv, _1: newSource} = sns.lazyList.head(allSolutions);
  if(newSource != source) { // server file itself modified from the update method
    sns.fileOperations = sns.fileOperations || [];
    sns.fileOperations.push([ 'write',
      { _1: serverFile,
        _2: newSource}]);
  }
  var fo = sns.fileOperations;
  var evaluated = evaluateToHtml(name, newEnv, newSource);
  sns.fileOperations = [];
  return [[evaluated, envToOverrides(newEnv), fo], sns.lazyList.tail(allSolutions)]; 
  // Evaluates everything given the temporary context of writing the files.
}

// Apply the given operations to the file system. TODO: Merge different writes to a single file.
function applyOperations(operations) {
  for(var i = 0; i < operations.length; i++) {
    var [kind, action] = operations[i];
    if(kind == "write") {
      var {_1: name, _2: content} = action;
      fs.writeFileSync(name, content, "utf8");
    } else if (kind == "delete") {
      var name = action;
      fs.unlinkSync(name);
    }
  }
}

// Returns a [Result of string containing the requested page, new overrides]
// If newvalue is defined, performs an update before returning the page.
function loadpage(name, overrides, newvalue) {
  // __dirname = path.resolve(); // If in the REPL
  if(typeof overrides != "object") overrides = {};
  var source =  readServerFile();
  var env = { vars: overrides, path: name };
  
  if(typeof newvalue == "undefined") {
    return [evaluateToHtml(name, env, source), overrides];
  } else { // We update the page and re-render it.
    var newVal = sns.nativeToVal(newvalue);
    sns.fileOperations = sns.fileOperations || [];
    var result = sns.objEnv.string.update(env)(source)(newVal);
    if(result.ctor == "Ok") {
      console.log("update succeeded");
      var allSolutions = result._0;
      // Instead of iterating through all the solutions, just detect if there is an ambiguity.
      var mbSolution = getOneSolution(name, source, allSolutions);
      if(mbSolution === false) {
        return [{ctor: "Err", _0: "Empty list of solutions"}];
      } else {
        [solution, tailSolutions] = mbSolution;
        var mbSolution2 = getOneSolution(name, source, tailSolutions);
        if(mbSolution2 === false) { // No ambiguity, we can immediately process the change.
          return solution;
        } else {
          console.log("ambiguity detected");
          var solutionKey = uniqueKey();
          [solution2, tailSolutions2] = mbSolution2;
          var cachedSolution = {
              timestamp: (+ new Date()),
              computed: [solution, solution2],
              remaining: tailSolutions2,
              name: name,
              source: source
          }
          cachedSolutions[solutionKey] = cachedSolution;
          return solution.concat(solutionKey);
        }
      }
    } else return [result];
  }
}

const server = http.createServer((request, response) => {
  var urlParts = url.parse(request.url, parseQueryString=true);
  var pathname = urlParts.pathname.substring(1); // Without the slash.
  var accessResult = sns.objEnv.string.evaluate({path:pathname,method:request.method})(readHtAccessFile());
  var access = sns.process(accessResult)(sns.valToNative);
  var header = 'text/html; charset=utf-8';
  if(access.ctor == "Err") {
    console.log("Error in htaccess", access._0);
    response.setHeader('Content-Type', header);
    response.statusCode = 500;
    response.end(`<html><body style="color:#cc0000"><div   style="max-width:600px;margin-left:auto;margin-right:auto"><h1>htaccess.elm internal Error report</h1><pre style="white-space:pre-wrap">${access._0}</pre></div></body></html>`);
  } else if(access._0) {
    if(request.method == "GET") {
      var q = urlParts.query;
      var header = pathname.endsWith(".ico") ? "image/ico" : header;
      var header = pathname.endsWith(".jpg") ? "image/jpg" : header;
      var header = pathname.endsWith(".gif") ? "image/gif" : header;
      var header = pathname.endsWith(".png") ? "image/png" : header;
      if(!header.startsWith("image/")) {
        var [htmlContent] = loadpage(pathname, urlParts.query);
        response.setHeader('Content-Type', header);
        response.statusCode = 200;
        if(htmlContent.ctor == "Err") {
          response.end(`<html><body style="color:#cc0000"><div   style="max-width:600px;margin-left:auto;margin-right:auto"><h1>Internal Error report</h1><pre style="white-space:pre-wrap">${htmlContent._0}</pre></div></body></html>`)
        } else {
          response.end(htmlContent._0);
        }
      } else {
        response.setHeader('Content-Type', header);
        var content = fs.readFileSync("./" + pathname);
        response.statusCode = 200;
        response.end(content);
      }
    } else if(request.method == "POST") {
    var body = '';
    request.on('data', function (data) {
        body += data;
    });
    request.on('end', function () {
        var pushedValue = JSON.parse(body);
        response.statusCode = 201;
        var [htmlContent, newQuery, fileOperations, otherSolutionsKey] = loadpage(pathname, urlParts.query, pushedValue);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        if(htmlContent.ctor == "Err") {
          response.end(`<html><body style="color:#cc0000"><div   style="max-width:600px;margin-left:auto;margin-right:auto"><h1>Internal Error report</h1><pre style="white-space:pre-wrap">${htmlContent._0}</pre></div></body></html>`)
        } else {
          response.setHeader('New-Query', JSON.stringify(newQuery));
          if(typeof otherSolutionsKey != "undefined" && !pathname.endsWith(".html") && !pathname.endsWith(".md")) {
            response.setHeader('Other-Solutions', JSON.stringify(otherSolutionsKey));
          } else {
            applyOperations(fileOperations);
          }
          sns.fileOperations = [];
          response.end(htmlContent._0);
        }
        });
    } else {
      response.statusCode = 200;
      response.end("Unknown method");
    }
  } else {
    response.statusCode = 401;
    response.end(`<html><body style="color:#cc0000"><div   style="max-width:600px;margin-left:auto;margin-right:auto"><h1>Unauthorized access to ${pathname}</h1></div></body></html>`);
  }
});


// Load the Elm program into our namespace.
console.log("Sketch-n-sketch Server ready !")
server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
  });