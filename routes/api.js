// Internal modules
var path = require("path");
var fs = require("fs");

// NPM modules
var request = require("request");
var lunr = require("lunr");
var rimraf = require("rimraf");
var mkdirp = require("mkdirp");
var router = require("express").Router();
var showdown  = require("showdown");
var converter = new showdown.Converter();
var fs2obj = require('fs2obj');

// Project modules
var config = require("../lib/config");

// Define base folder for dcos/examples repo
var dcosExamplesFolder = path.join(__dirname, "../", "dcos-examples");

// Clean dcos/examples repo folder
rimraf.sync(dcosExamplesFolder);

// Global git object
var git = {};

// Create cache object for the dcos/example packages
var exampleCache = {};

// Placeholder for the pull interval
var pullInterval = {};

// Placeholder for the repository interval
var repositoryInterval = {};

// Create clean folder for dcos/examples repo
mkdirp(dcosExamplesFolder, function (err) {
    if (err) {
        console.error(err);
        process.exit(1);
    } else {
        console.log("Created folder for repo dcos/examples");
        // Instantiate git
        git = require('simple-git')(dcosExamplesFolder);
        // Clone the repo
        git.clone("https://github.com/dcos/examples.git", dcosExamplesFolder, {}, function (err, result) {
            if (err) {
                console.log(err);
                process.exit(1);
            } else {
                console.log("Successfully cloned dcos/example repository");
                // Fill the examplesCache with the rendered results of the markdown files
                fillExamples();
                console.log("Generated and cached HTML from the dcos/example repository");
                // Load the repository initially
                loadRepository();
                console.log("Initially loaded the DC/OS repository information");
                // Set the periodical "git pull" as interval, every 5 minutes
                pullInterval = setInterval(function () {
                    var startTime = new Date().getTime();
                    git.pull("origin", "master", function(err, result) {
                        var endTime = new Date().getTime();
                        if (err) {
                            console.log("Pull from origin/master failed in " + (endTime-startTime) + "ms");
                            console.log(err);
                            //process.exit(1);
                        } else {
                            console.log("Successfully pulled from origin/master in " + (endTime-startTime) + "ms");
                            // Fill the examplesCache with the rendered results of the markdown files
                            fillExamples();
                            console.log("Updated and cached HTML from the dcos/example repository");
                        }
                    });
                }, config.application.refresh.examples);
                console.log("Started dcos/example pull interval (" + (config.application.refresh.examples/1000) + " secs)!");
                // Set periodical for repository refresh as interval
                repositoryInterval = setInterval(loadRepository, config.application.refresh.universe);
                console.log("Started load repository interval (" + (config.application.refresh.universe/1000) + " secs)!");
            }
        });
    }
});

function fillExamples() {

    // Read the folder/file structure
    var folderStructure = fs2obj(dcosExamplesFolder + "/1.8");

    // Reset exampleCache
    exampleCache = {};

    // Iterate over items
    folderStructure.items.forEach(function (item) {
        // Use folders
        if (item.type === "folder") {
            var packageName = item.name.toLowerCase();
            var baseUrl = "https://raw.githubusercontent.com/dcos/examples/master/1.8/" + packageName;
            // Read README.md contents
            var exampleContents = fs.readFileSync(dcosExamplesFolder + "/1.8/" + packageName + "/README.md", "utf8").toString();
            // There is an example for this package
            exampleCache[packageName] = {
                renderedHtml: converter.makeHtml(exampleContents).replace(/img\//g, baseUrl + "/img/"), // Replace relative URL with absolute URL
                enabled: true
            };
        }
    });

}

// Sample call to DC/OS universe
// curl -X GET -L -H "user-agent: dcos/1.8" -H "accept: application/vnd.dcos.universe.repo+json;charset=utf-8;version=v3" "https://universe.mesosphere.com/repo"

// Set request options
var options = {
    "headers": {
        "user-agent": "dcos/1.8",
        "accept": "application/vnd.dcos.universe.repo+json;charset=utf-8;version=v3"
    },
    "uri": "https://universe.mesosphere.com/repo",
    "method": "GET"
};

// Create packages singleton
var packages = {
    index: lunr(function () {
        this.field("name");
        this.field("tags", {boost: 10});
        this.field("description");
        this.field("releaseVersion");
        this.ref("name")
    }),
    map: {},
    list: []
};

//
var resetPackages = function () {
    packages.index = lunr(function () {
        this.field("name");
        this.field("tags", {boost: 10});
        this.field("description");
        this.field("releaseVersion");
        this.ref("name")
    });
    // Reset other properties
    packages.list.length = 0;
    packages.map = {};
};

function generateSortFn(prop, reverse) {
    return function (a, b) {
        if (a[prop] < b[prop]) return reverse ? 1 : -1;
        if (a[prop] > b[prop]) return reverse ? -1 : 1;
        return 0;
    };
}

var loadRepository = function () {
    request(options, function (error, response, body) {
        if (!error && response.statusCode == 200) {

            var universeResponse = JSON.parse(body);

            // Reset package singleton
            resetPackages();

            // Create temporary array
            var tempPackagesArray = [];

            // Iterate over the packages/package versions
            universeResponse.packages.forEach(function (packageObj) {

                // Initialize the package if it doesn't exist yet
                if (!packages.map.hasOwnProperty(packageObj.name)) {
                    packages.map[packageObj.name] = {
                        versions: {},
                        releaseVersions: {},
                        latest: null,
                        latestVersion: -1
                    }
                }

                var imagesObj = {};
                var screenshots = {};

                // Replace plain http image urls with https urls, to get rid of mixed-content warnings
                // Workaround for excluding erroneous packages"dynatrace", "sysdig-cloud" -> Remove once they're fixed
                if (packageObj.resource.images && Object.getOwnPropertyNames(packageObj.resource.images).length > 0 && ["dynatrace", "sysdig-cloud"].indexOf(packageObj.name) === -1) {
                    if (packageObj.resource.images.screenshots) {
                        screenshots = packageObj.resource.images.screenshots;
                        delete packageObj.resource.images.screenshots;
                    }
                    Object.getOwnPropertyNames(packageObj.resource.images).forEach(function (imageType) {
                        imagesObj[imageType] = packageObj.resource.images[imageType].replace(/^http:\/\//i, 'https://');
                    });
                } else {
                    // Assign placeholder images in the correct dimensions
                    imagesObj = {
                        "icon-small": "https://placehold.it/48x48&text=" + packageObj.name,
                        "icon-medium": "https://placehold.it/96x96&text=" + packageObj.name,
                        "icon-large": "https://placehold.it/256x256&text=" + packageObj.name
                    }
                }

                // Create smaller packageObj
                var smallPackageObj = {
                    id: packageObj.name + "-" + packageObj.releaseVersion,
                    name: packageObj.name,
                    description: packageObj.description,
                    tags: packageObj.tags,
                    version: packageObj.version,
                    releaseVersion: packageObj.releaseVersion,
                    packagingVersion: packageObj.packagingVersion,
                    minDcosReleaseVersion: packageObj.minDcosReleaseVersion,
                    maintainer: packageObj.maintainer || null,
                    website: packageObj.website || null,
                    scm: packageObj.scm || null,
                    isFramework: packageObj.framework || false,
                    preInstallNotes: packageObj.preInstallNotes || null,
                    postInstallNotes: packageObj.postInstallNotes || null,
                    postUninstallNotes: packageObj.postUninstallNotes || null,
                    licenses: packageObj.licenses || null,
                    images: imagesObj,
                    screenshots: screenshots || null,
                    hasExample : ((exampleCache[packageObj.name] && exampleCache[packageObj.name].hasOwnProperty("enabled")) ? exampleCache[packageObj.name].enabled : false)
                };

                // Create version map entry
                packages.map[packageObj.name].releaseVersions[packageObj.releaseVersion.toString()] = smallPackageObj;
                packages.map[packageObj.name].versions[packageObj.version.toString()] = smallPackageObj;

                // Check if it's the latest release version, if so sure the version number
                if (packages.map[packageObj.name].latestVersion < packageObj.releaseVersion) {
                    // Set the latestVersion
                    packages.map[packageObj.name].latestVersion = packageObj.releaseVersion;
                    // Set the packageObj as current latest
                    packages.map[packageObj.name].latest = smallPackageObj;
                }

            });

            // Get latest versions per package, and store them (for search)
            Object.getOwnPropertyNames(packages.map).forEach(function (packageName) {
                // Get current package
                var latestPackageVersion = packages.map[packageName].latest;
                // Add to tempPackagesArray
                tempPackagesArray.push(latestPackageVersion);
                // Index the current package
                packages.index.add({
                    name: latestPackageVersion.name,
                    description: latestPackageVersion.description,
                    tags: latestPackageVersion.tags,
                    releaseVersion: latestPackageVersion.releaseVersion
                });
            });

            // Store the array as pac
            packages.list = tempPackagesArray.sort(generateSortFn("name", false));

        }
    });
};

router.get("/search", function(req, res) {

    var searchString = req.query.q;

    var searchResult = packages.index.search(searchString);

    var resultArray = [];

    searchResult.forEach(function (searchResult) {
        resultArray.push(packages.map[searchResult.ref].latest);
    });

    res.json({ results: resultArray });

});

router.get("/packages", function(req, res) {

    res.json(packages.list);

});

router.get("/package/:packageName/docs", function(req, res) {

    if (packages.map[req.params.packageName]) {

        // Check if there there's already a renderedHtml property
        if (exampleCache.hasOwnProperty(req.params.packageName) && exampleCache[req.params.packageName].renderedHtml) {

            // Send renderedHtml
            res.send(exampleCache[req.params.packageName].renderedHtml);

        } else {

            var baseUrl = "https://raw.githubusercontent.com/dcos/examples/master/1.8/" + req.params.packageName;

            request({
                method: "GET",
                uri: baseUrl + "/README.md"
            }, function (error, response, body) {
                if (!error && response.statusCode == 200) {

                    var renderedHtml = converter.makeHtml(body).replace(/img\//g, baseUrl + "/img/"); // Replace relative URL with absolute URL

                    // There is an example for this package
                    exampleCache[req.params.packageName] = {
                        renderedHtml: renderedHtml,
                        interval: setInterval(function() { loadExample(req.params.packageName); } , 60000),
                        enabled: true
                    };

                    res.send(renderedHtml);

                } else {
                    exampleCache[req.params.packageName] = {
                        interval: setInterval(function() { loadExample(req.params.packageName); } , 60000),
                        enabled: false
                    };
                    res.status(404).send("");
                }
            });

        }

    } else {
        res.status(404).send("");
    }

});

router.get("/package/:packageName/version/:packageVersion", function(req, res) {

    if (packages.map[req.params.packageName]) {

        if (req.params.packageVersion === "latest") {
            res.json(packages.map[req.params.packageName].latest)
        } else {
            if (packages.map[req.params.packageName].versions.hasOwnProperty(req.params.packageVersion)) {
                res.json(packages.map[req.params.packageName].versions[req.params.packageVersion])
            } else {
                res.status(404).json({ error: "No matching package version found!" });
            }
        }

    } else {
        res.status(404).json({ error: "No matching package found!" });
    }

});

router.get("/package/:packageName/releaseVersion/:packageReleaseVersion", function(req, res) {

    if (packages.map[req.params.packageName]) {

        if (req.params.packageReleaseVersion === "latest") {
            res.json(packages.map[req.params.packageName].latest)
        } else {
            if (packages.map[req.params.packageName].releaseVersions.hasOwnProperty(req.params.packageReleaseVersion)) {
                res.json(packages.map[req.params.packageName].releaseVersions[req.params.packageReleaseVersion])
            } else {
                res.status(404).json({ error: "No matching package version found!" });
            }
        }

    } else {
        res.status(404).json({ error: "No matching package found!" });
    }

});

router.get("/package/:packageName/versions", function(req, res) {

    if (packages.map[req.params.packageName]) {

        res.json({
            name: req.params.packageName,
            versions: Object.getOwnPropertyNames(packages.map[req.params.packageName].versions).sort()
        });

    } else {
        res.json({ error: "No matching package found!" });
    }

});

router.get("/package/:packageName/releaseVersions", function(req, res) {

    if (packages.map[req.params.packageName]) {

        res.json({
            name: req.params.packageName,
            releaseVersions: Object.getOwnPropertyNames(packages.map[req.params.packageName].releaseVersions).sort()
        });

    } else {
        res.json({ error: "No matching package found!" });
    }

});

module.exports = router;