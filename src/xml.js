/*
	JavaScript XML Library
	Plus a bunch of object utility functions
	
	Usage:
		var XML = require('pixl-xml');
		var myxmlstring = '<?xml version="1.0"?><Document>' + 
			'<Simple>Hello</Simple>' + 
			'<Node Key="Value">Content</Node>' + 
			'</Document>';
		
		var tree = XML.parse( myxmlstring, { preserveAttributes: true });
		console.log( tree );
		
		tree.Simple = "Hello2";
		tree.Node._Attribs.Key = "Value2";
		tree.Node._Data = "Content2";
		tree.New = "I added this";
		
		console.log( XML.stringify( tree, 'Document' ) );
	
	Copyright (c) 2004 - 2015 Joseph Huckaby
	Released under the MIT License
	This version is for Node.JS, converted in 2012.
*/

var fs = require('fs');
var util = require('util');

var isArray = Array.isArray || util.isArray; // support for older Node.js

var xml_header = '<?xml version="1.0"?>';
var sort_args = null;
var re_valid_tag_name = /^\w[\w\-\:\.]*$/;

var XML = exports.XML = exports.Parser = function XML(args, opts) {
	// class constructor for XML parser class
	// pass in args hash or text to parse
	if (!args) args = '';
	if (isa_hash(args)) {
		for (var key in args) this[key] = args[key];
	}
	else this.text = args || '';

	// options may be 2nd argument as well
	if (opts) {
		for (var key in opts) this[key] = opts[key];
	}

	// stringify buffers
	if (this.text instanceof Buffer) {
		this.text = this.text.toString();
	}

	if (!this.text.match(/^\s*</)) {
		// try as file path
		var file = this.text;
		this.text = fs.readFileSync(file, { encoding: 'utf8' });
		if (!this.text) throw new Error("File not found: " + file);
	}

	this.tree = {};
	this.errors = [];
	this.piNodeList = [];
	this.dtdNodeList = [];
	this.documentNodeName = '';

	if (this.lowerCase) {
		this.attribsKey = this.attribsKey.toLowerCase();
		this.dataKey = this.dataKey.toLowerCase();
	}

	this.patTag.lastIndex = 0;
	if (this.text) this.parse();
}

XML.prototype.preserveDocumentNode = false;
XML.prototype.preserveAttributes = false;
XML.prototype.preserveWhitespace = false;
XML.prototype.lowerCase = false;
XML.prototype.forceArrays = false;

XML.prototype.patTag = /([^<]*?)<([^>]+)>/g;
XML.prototype.patSpecialTag = /^\s*([\!\?])/;
XML.prototype.patPITag = /^\s*\?/;
XML.prototype.patCommentTag = /^\s*\!--/;
XML.prototype.patDTDTag = /^\s*\!DOCTYPE/;
XML.prototype.patCDATATag = /^\s*\!\s*\[\s*CDATA/;
XML.prototype.patStandardTag = /^\s*(\/?)([\w\-\:\.]+)\s*([\s\S]*)$/;
XML.prototype.patSelfClosing = /\/\s*$/;
XML.prototype.patAttrib = new RegExp("([\\w\\-\\:\\.]+)\\s*=\\s*([\\\"\\'])([^\\2]*?)\\2", "g");
XML.prototype.patPINode = /^\s*\?\s*([\w\-\:]+)\s*(.*)$/;
XML.prototype.patEndComment = /--$/;
XML.prototype.patNextClose = /([^>]*?)>/g;
XML.prototype.patExternalDTDNode = new RegExp("^\\s*\\!DOCTYPE\\s+([\\w\\-\\:]+)\\s+(SYSTEM|PUBLIC)\\s+\\\"([^\\\"]+)\\\"");
XML.prototype.patInlineDTDNode = /^\s*\!DOCTYPE\s+([\w\-\:]+)\s+\[/;
XML.prototype.patEndDTD = /\]$/;
XML.prototype.patDTDNode = /^\s*\!DOCTYPE\s+([\w\-\:]+)\s+\[(.*)\]/;
XML.prototype.patEndCDATA = /\]\]$/;
XML.prototype.patCDATANode = /^\s*\!\s*\[\s*CDATA\s*\[([^]*)\]\]/;

XML.prototype.attribsKey = '_Attribs';
XML.prototype.dataKey = '_Data';

XML.prototype.parse = function (branch, name) {
	// parse text into XML tree, recurse for nested nodes
	if (!branch) branch = this.tree;
	if (!name) name = null;
	var foundClosing = false;
	var matches = null;

	// match each tag, plus preceding text
	while (matches = this.patTag.exec(this.text)) {
		var before = matches[1];
		var tag = matches[2];

		// text leading up to tag = content of parent node
		if (before.match(/\S/)) {
			if (typeof (branch[this.dataKey]) != 'undefined') branch[this.dataKey] += ' '; else branch[this.dataKey] = '';
			branch[this.dataKey] += !this.preserveWhitespace ? trim(decode_entities(before)) : decode_entities(before);
		}

		// parse based on tag type
		if (tag.match(this.patSpecialTag)) {
			// special tag
			if (tag.match(this.patPITag)) tag = this.parsePINode(tag);
			else if (tag.match(this.patCommentTag)) tag = this.parseCommentNode(tag);
			else if (tag.match(this.patDTDTag)) tag = this.parseDTDNode(tag);
			else if (tag.match(this.patCDATATag)) {
				tag = this.parseCDATANode(tag);
				if (typeof (branch[this.dataKey]) != 'undefined') branch[this.dataKey] += ' '; else branch[this.dataKey] = '';
				branch[this.dataKey] += !this.preserveWhitespace ? trim(decode_entities(tag)) : decode_entities(tag);
			} // cdata
			else {
				this.throwParseError("Malformed special tag", tag);
				break;
			} // error

			if (tag == null) break;
			continue;
		} // special tag
		else {
			// Tag is standard, so parse name and attributes (if any)
			var matches = tag.match(this.patStandardTag);
			if (!matches) {
				this.throwParseError("Malformed tag", tag);
				break;
			}

			var closing = matches[1];
			var nodeName = this.lowerCase ? matches[2].toLowerCase() : matches[2];
			var attribsRaw = matches[3];

			// If this is a closing tag, make sure it matches its opening tag
			if (closing) {
				if (nodeName == (name || '')) {
					foundClosing = 1;
					break;
				}
				else {
					this.throwParseError("Mismatched closing tag (expected </" + name + ">)", tag);
					break;
				}
			} // closing tag
			else {
				// Not a closing tag, so parse attributes into hash.  If tag
				// is self-closing, no recursive parsing is needed.
				var selfClosing = !!attribsRaw.match(this.patSelfClosing);
				var leaf = {};
				var attribs = leaf;

				// preserve attributes means they go into a sub-hash named "_Attribs"
				// the XML composer honors this for restoring the tree back into XML
				if (this.preserveAttributes) {
					leaf[this.attribsKey] = {};
					attribs = leaf[this.attribsKey];
				}

				// parse attributes
				this.patAttrib.lastIndex = 0;
				while (matches = this.patAttrib.exec(attribsRaw)) {
					var key = this.lowerCase ? matches[1].toLowerCase() : matches[1];
					attribs[key] = decode_entities(matches[3]);
				} // foreach attrib

				// if no attribs found, but we created the _Attribs subhash, clean it up now
				if (this.preserveAttributes && !num_keys(attribs)) {
					delete leaf[this.attribsKey];
				}

				// Recurse for nested nodes
				if (!selfClosing) {
					this.parse(leaf, nodeName);
					if (this.error()) break;
				}

				// Compress into simple node if text only
				var num_leaf_keys = num_keys(leaf);
				if ((typeof (leaf[this.dataKey]) != 'undefined') && (num_leaf_keys == 1)) {
					leaf = leaf[this.dataKey];
				}
				else if (!num_leaf_keys) {
					leaf = '';
				}

				// Add leaf to parent branch
				if (typeof (branch[nodeName]) != 'undefined') {
					if (isa_array(branch[nodeName])) {
						branch[nodeName].push(leaf);
					}
					else {
						var temp = branch[nodeName];
						branch[nodeName] = [temp, leaf];
					}
				}
				else if (this.forceArrays && (branch != this.tree)) {
					branch[nodeName] = [leaf];
				}
				else {
					branch[nodeName] = leaf;
				}

				if (this.error() || (branch == this.tree)) break;
			} // not closing
		} // standard tag
	} // main reg exp

	// Make sure we found the closing tag
	if (name && !foundClosing) {
		this.throwParseError("Missing closing tag (expected </" + name + ">)", name);
	}

	// If we are the master node, finish parsing and setup our doc node
	if (branch == this.tree) {
		if (typeof (this.tree[this.dataKey]) != 'undefined') delete this.tree[this.dataKey];

		if (num_keys(this.tree) > 1) {
			this.throwParseError('Only one top-level node is allowed in document', first_key(this.tree));
			return;
		}

		this.documentNodeName = first_key(this.tree);
		if (this.documentNodeName && !this.preserveDocumentNode) {
			this.tree = this.tree[this.documentNodeName];
		}
	}
};

XML.prototype.throwParseError = function (key, tag) {
	// log error and locate current line number in source XML document
	var parsedSource = this.text.substring(0, this.patTag.lastIndex);
	var eolMatch = parsedSource.match(/\n/g);
	var lineNum = (eolMatch ? eolMatch.length : 0) + 1;
	lineNum -= tag.match(/\n/) ? tag.match(/\n/g).length : 0;

	this.errors.push({
		type: 'Parse',
		key: key,
		text: '<' + tag + '>',
		line: lineNum
	});

	// Throw actual error (must wrap parse in try/catch)
	throw new Error(this.getLastError());
};

XML.prototype.error = function () {
	// return number of errors
	return this.errors.length;
};

XML.prototype.getError = function (error) {
	// get formatted error
	var text = '';
	if (!error) return '';

	text = (error.type || 'General') + ' Error';
	if (error.code) text += ' ' + error.code;
	text += ': ' + error.key;

	if (error.line) text += ' on line ' + error.line;
	if (error.text) text += ': ' + error.text;

	return text;
};

XML.prototype.getLastError = function () {
	// Get most recently thrown error in plain text format
	if (!this.error()) return '';
	return this.getError(this.errors[this.errors.length - 1]);
};

XML.prototype.parsePINode = function (tag) {
	// Parse Processor Instruction Node, e.g. <?xml version="1.0"?>
	if (!tag.match(this.patPINode)) {
		this.throwParseError("Malformed processor instruction", tag);
		return null;
	}

	this.piNodeList.push(tag);
	return tag;
};

XML.prototype.parseCommentNode = function (tag) {
	// Parse Comment Node, e.g. <!-- hello -->
	var matches = null;
	this.patNextClose.lastIndex = this.patTag.lastIndex;

	while (!tag.match(this.patEndComment)) {
		if (matches = this.patNextClose.exec(this.text)) {
			tag += '>' + matches[1];
		}
		else {
			this.throwParseError("Unclosed comment tag", tag);
			return null;
		}
	}

	this.patTag.lastIndex = this.patNextClose.lastIndex;
	return tag;
};

XML.prototype.parseDTDNode = function (tag) {
	// Parse Document Type Descriptor Node, e.g. <!DOCTYPE ... >
	var matches = null;

	if (tag.match(this.patExternalDTDNode)) {
		// tag is external, and thus self-closing
		this.dtdNodeList.push(tag);
	}
	else if (tag.match(this.patInlineDTDNode)) {
		// Tag is inline, so check for nested nodes.
		this.patNextClose.lastIndex = this.patTag.lastIndex;

		while (!tag.match(this.patEndDTD)) {
			if (matches = this.patNextClose.exec(this.text)) {
				tag += '>' + matches[1];
			}
			else {
				this.throwParseError("Unclosed DTD tag", tag);
				return null;
			}
		}

		this.patTag.lastIndex = this.patNextClose.lastIndex;

		// Make sure complete tag is well-formed, and push onto DTD stack.
		if (tag.match(this.patDTDNode)) {
			this.dtdNodeList.push(tag);
		}
		else {
			this.throwParseError("Malformed DTD tag", tag);
			return null;
		}
	}
	else {
		this.throwParseError("Malformed DTD tag", tag);
		return null;
	}

	return tag;
};

XML.prototype.parseCDATANode = function (tag) {
	// Parse CDATA Node, e.g. <![CDATA[Brooks & Shields]]>
	var matches = null;
	this.patNextClose.lastIndex = this.patTag.lastIndex;

	while (!tag.match(this.patEndCDATA)) {
		if (matches = this.patNextClose.exec(this.text)) {
			tag += '>' + matches[1];
		}
		else {
			this.throwParseError("Unclosed CDATA tag", tag);
			return null;
		}
	}

	this.patTag.lastIndex = this.patNextClose.lastIndex;

	if (matches = tag.match(this.patCDATANode)) {
		return matches[1];
	}
	else {
		this.throwParseError("Malformed CDATA tag", tag);
		return null;
	}
};

XML.prototype.getTree = function () {
	// get reference to parsed XML tree
	return this.tree;
};

XML.prototype.compose = function (indent_string, eol, tag_sorter_by_name, tag_sorter_with_same_name, attribute_sorter) {
	// compose tree back into XML
	if (typeof (eol) == 'undefined') eol = "\n";
	var tree = this.tree;
	if (this.preserveDocumentNode) tree = tree[this.documentNodeName];

	var raw = compose_xml(tree, this.documentNodeName, 0, indent_string, eol, true, tag_sorter_by_name, tag_sorter_with_same_name, attribute_sorter);
	var body = raw.replace(/^\s*\<\?.+?\?\>\s*/, '');
	var xml = '';

	if (this.piNodeList.length) {
		for (var idx = 0, len = this.piNodeList.length; idx < len; idx++) {
			xml += '<' + this.piNodeList[idx] + '>' + eol;
		}
	}
	else {
		xml += xml_header + eol;
	}

	if (this.dtdNodeList.length) {
		for (var idx = 0, len = this.dtdNodeList.length; idx < len; idx++) {
			xml += '<' + this.dtdNodeList[idx] + '>' + eol;
		}
	}

	xml += body;
	return xml;
};

//
// Static Utility Functions:
//

var parse_xml = exports.parse = function parse_xml(text, opts) {
	// turn text into XML tree quickly
	if (!opts) opts = {};
	opts.text = text;
	var parser = new XML(opts);
	return parser.error() ? parser.getLastError() : parser.getTree();
};

var trim = exports.trim = function trim(text) {
	// strip whitespace from beginning and end of string
	if (text == null) return '';

	if (text && text.replace) {
		text = text.replace(/^\s+/, "");
		text = text.replace(/\s+$/, "");
	}

	return text;
};

var encode_entities = exports.encodeEntities = function encode_entities(text) {
	// Simple entitize exports.for = function for composing XML
	if (text == null) return '';

	if (text && text.replace) {
		text = text.replace(/\&/g, "&amp;"); // MUST BE FIRST
		text = text.replace(/</g, "&lt;");
		text = text.replace(/>/g, "&gt;");
	}

	return text;
};

var encode_attrib_entities = exports.encodeAttribEntities = function encode_attrib_entities(text) {
	// Simple entitize exports.for = function for composing XML attributes
	if (text == null) return '';

	if (text && text.replace) {
		text = text.replace(/\&/g, "&amp;"); // MUST BE FIRST
		text = text.replace(/</g, "&lt;");
		text = text.replace(/>/g, "&gt;");
		text = text.replace(/\"/g, "&quot;");
		text = text.replace(/\'/g, "&apos;");
	}

	return text;
};

var decode_entities = exports.decodeEntities = function decode_entities(text) {
	// Decode XML entities into raw ASCII
	if (text == null) return '';

	if (text && text.replace && text.match(/\&/)) {
		text = text.replace(/\&lt\;/g, "<");
		text = text.replace(/\&gt\;/g, ">");
		text = text.replace(/\&quot\;/g, '"');
		text = text.replace(/\&apos\;/g, "'");
		text = text.replace(/\&amp\;/g, "&"); // MUST BE LAST
	}

	return text;
};

var compose_xml = exports.stringify = function compose_xml(node, name, indent, indent_string, eol, sort, tag_sorter_by_name, tag_sorter_with_same_name, attribute_sorter) {
	// Compose node into XML including attributes
	// Recurse for child nodes
	if (typeof (indent_string) == 'undefined') indent_string = "\t";
	if (typeof (eol) == 'undefined') eol = "\n";
	if (typeof (sort) == 'undefined') sort = true;
	var xml = "";

	// If this is the root node, set the indent to 0
	// and setup the XML header (PI node)
	if (!indent) {
		indent = 0;
		xml = xml_header + eol;

		if (!name) {
			// no name provided, assume content is wrapped in it
			name = first_key(node);
			node = node[name];
		}
	}

	// Setup the indent text
	var indent_text = "";
	for (var k = 0; k < indent; k++) indent_text += indent_string;

	if ((typeof (node) == 'object') && (node != null)) {
		// node is object -- now see if it is an array or hash
		if (!node.length) { // what about zero-length array?
			// node is hash
			xml += indent_text + "<" + name;

			var num_keys = 0;
			var has_attribs = 0;
			for (var key in node) num_keys++; // there must be a better way...

			if (node["_Attribs"]) {
				has_attribs = 1;
				var sorted_keys = sort ? hash_keys_to_array(node["_Attribs"]).sort(attribute_sorter) : hash_keys_to_array(node["_Attribs"]);
				for (var idx = 0, len = sorted_keys.length; idx < len; idx++) {
					var key = sorted_keys[idx];
					xml += " " + key + "=\"" + encode_attrib_entities(node["_Attribs"][key]) + "\"";
				}
			} // has attribs

			if (num_keys > has_attribs) {
				// has child elements
				xml += ">";

				if (node["_Data"]) {
					// simple text child node
					xml += encode_entities(node["_Data"]) + "</" + name + ">" + eol;
				} // just text
				else {
					xml += eol;

					var sorted_keys = sort ? hash_keys_to_array(node).sort(tag_sorter_by_name) : hash_keys_to_array(node);
					for (var idx = 0, len = sorted_keys.length; idx < len; idx++) {
						var key = sorted_keys[idx];
						if ((key != "_Attribs") && key.match(re_valid_tag_name)) {
							// recurse for node, with incremented indent value
							xml += compose_xml(node[key], key, indent + 1, indent_string, eol, sort, tag_sorter_by_name, tag_sorter_with_same_name, attribute_sorter);
						} // not _Attribs key
					} // foreach key

					xml += indent_text + "</" + name + ">" + eol;
				} // real children
			}
			else {
				// no child elements, so self-close
				xml += "/>" + eol;
			}
		} // standard node
		else {
			// node is array
			node = sort ? node.sort(tag_sorter_with_same_name) : node;
			for (var idx = 0; idx < node.length; idx++) {
				// recurse for node in array with same indent
				xml += compose_xml(node[idx], name, indent, indent_string, eol, sort, tag_sorter_by_name, tag_sorter_with_same_name, attribute_sorter);
			}
		} // array of nodes
	} // complex node
	else {
		// node is simple string
		xml += indent_text + "<" + name + ">" + node + "</" + name + ">" + eol;
	} // simple text node

	return xml;
};

var always_array = exports.alwaysArray = function always_array(obj, key) {
	// if object is not array, return array containing object
	// if key is passed, work like XMLalwaysarray() instead
	if (key) {
		if ((typeof (obj[key]) != 'object') || (typeof (obj[key].length) == 'undefined')) {
			var temp = obj[key];
			delete obj[key];
			obj[key] = new Array();
			obj[key][0] = temp;
		}
		return null;
	}
	else {
		if ((typeof (obj) != 'object') || (typeof (obj.length) == 'undefined')) { return [obj]; }
		else return obj;
	}
};

var hash_keys_to_array = exports.hashKeysToArray = function hash_keys_to_array(hash) {
	// convert hash keys to array (discard values)
	var array = [];
	for (var key in hash) array.push(key);
	return array;
};

var isa_array = exports.isaArray = function isa_array(arg) {
	// determine if arg is an array or is array-like
	return isArray(arg);
};

var isa_hash = exports.isaHash = function isa_hash(arg) {
	// determine if arg is a hash
	return (!!arg && (typeof (arg) == 'object') && !isa_array(arg));
};

var first_key = exports.firstKey = function first_key(hash) {
	// return first key from hash (unordered)
	for (var key in hash) return key;
	return null; // no keys in hash
};

var num_keys = exports.numKeys = function num_keys(hash) {
	// count the number of keys in a hash
	var count = 0;
	for (var a in hash) count++;
	return count;
};
