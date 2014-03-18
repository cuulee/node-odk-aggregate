var express = require('express');
var multiparty = require('multiparty');
var fs = require('fs');
var path = require('path');

var persist = require('./lib/persist.js');
var odk2json = require('./lib/odk2json.js');

// These headers are required according to https://bitbucket.org/javarosa/javarosa/wiki/OpenRosaRequest
var OpenRosaHeaders = {
    "X-OpenRosa-Accept-Content-Length": process.env.ACCEPT_CONTENT_LENGTH,
    "X-OpenRosa-Version": "1.0"
};

var app = express();

// Need to respond to HEAD request as stated in https://bitbucket.org/javarosa/javarosa/wiki/FormSubmissionAPI
app.head('/submission', function(req, res) {
    res.set(OpenRosaHeaders);
    res.send(204);
});

// Receive webhook post
app.post('/submission', function(req, res) {

    res.set(OpenRosaHeaders);

    // Create a Multiparty form parser which will calculate md5 hashes of each file received
    var form = new multiparty.Form({
        hash: "md5"
    });

    var mediaFiles = {};
    var xmlFile;

    // To keep the connection active on Heroku during long uploads, send a "processing" 102 status code every 20 seconds
    // See https://devcenter.heroku.com/articles/request-timeout
    var ping = setTimeout(function() {
        res.send(102);
        ping = setInterval(function() {
            res.send(102);
        });
    }, 15 * 1000);

    form.on('file', function(name, file) {
        // We will need the content-type and content-length for Amazon S3 uploads
        // (this is why we can't stream the response directly to S3, since
        //  we don't know the file size until we receive the whole file)
        var headers = {
            "content-type": file.headers["content-type"],
            "content-length": file.size
        };

        if (name === "xml_submission_file") {
            // If the file is the xml form data, store a reference to it for later.
            xmlFile = file.path;
        } else {
            // Any other files, stream them to persist them.
            var stream = fs.createReadStream(file.path);
            // The filename is the md5 hash of the file with the original filename
            var filename = file.hash + path.extname(file.originalFilename);
            mediaFiles[file.originalFilename] = filename;
            // Persist the result, to the filesystem or to Amazon S3
            persist(stream, filename, headers, function(err) {
                if (err) console.log(err);
                else console.log("saved ", filename);
            });
        }
    });

    form.on('close', function() {
        clearTimeout(ping);
        clearInterval(ping);

        if (!xmlFile) {
            res.send("Missing xml file");
            res.send(400);
        } else {
            fs.readFile(xmlFile, function(err, data) {
                // parse the xml form response into a JSON string.
                odk2json(data, mediaFiles, req.query, function(err, result) {
                    // Place forms in a folder named with the formId, and name the form from its instanceId
                    var filepath = result.formId + "/" + result.instanceId.replace(/^uuid:/, "") + ".json";
                    // Persist the result (could be filesystem, could be Github)
                    persist(result.json, filepath, { "content-type": "text/xml" }, function(err) {
                        if (err) console.log(err);
                        else console.log("saved ", filepath);
                    });
                    res.send(400);
                });
            });
        }
    });

    // Close connection
    form.parse(req);

});

// Start server
var port = process.env.PORT || 8080;
app.listen(port);
console.log('Listening on port ' + port);
