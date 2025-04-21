"use strict";
/*
-----
Rules
-----

1. Commands are separated by newlines (\r\n or \n).
        - standalone '\r' is illegal outside quoted string
2. Tokens are separated by whitespaces (0x20, \t).
        - Non-quoted tokens: any printable character on ANSI keyboard, except any brackets ()[]{}<> and any quotes "'` and backslash \
        - Special non-quoted token: `&&` will be emitted by tokenizer as AndAnd token.
        - Special non-quoted token: `--` will be emitted by tokenizer as regular token, will be interpreted by parser as positional separator
        - Quoted tokens: delimited by a balanced number of quotes on each side.
                - "a" is ok, """a""" is ok, """"a"""" is ok, etc, but not ""a"", because double quotes is empty string.
                - All three quote characters "'` can be used, but the same kind must be on each side.
                - Allow escape sequences \t, \r, \n, \', \", \`
3. First token is command
4. A non-quoted token starting with "-" is an option.
5. A non-quoted token starting with anything else is a positional argument.
6. A quoted token is a positional argument.
7. Quoted strings cannot appear back to back. <"a""b"> is legal for bash but illegal for this.
8. Quoted string and an unquoted term cannot appear back to back in that order. <"a"b> is illegal.
9. Unquoted term and quoted string can appear back to back, in that order. <a"b"> is legal and is equivalent to <ab>.
        - The concatenated string will be treated as non-quoted (to allow special characters in options like --"'" to encode otherwise illegal --')
        - Not chainable. <a"b"c>, <a"b""c"> are illegal.
9. If a positional argument follows an option, the positional argument is 'absorbed' into the option.
10. Backslash outside of quoted strings can escape linebreaks. White space is allowed between \ and linebreak, and will not affect the escaping

--------
Examples
--------

firewall-cmd --add-port "443/tcp"

After lexing: Tokens [ Nonquoted("firewall-cmd"), Nonquoted("--add-port"), Quoted("443/tcp") ]
After parsing: { command = "firewall-cmd"; args = [ ]; options = [ ("--add-port", "443/tcp") ] }

firewall-cmd --add-port="443/tcp"

After lexing: Tokens [ Nonquoted("firewall-cmd"), Nonquoted("--add-port=443/tcp") ]
After parsing: { command = "firewall-cmd"; args = [ ]; options = [ ("--add-port=443/tcp", null) ] }

firewall-cmd --add-port 443/tcp {
        subcommand a
        subcommand b
}

After lexing: Tokens [ Nonquoted("firewall-cmd"), Nonquoted("--add-port"), Nonquoted("443/tcp"), OpenBrace, LineBreak, Nonquoted("subcommand"), Nonquoted("a"), LineBreak, Nonquoted("subcommand"), Nonquoted("b"), LineBreak, CloseBrace ]
After parseing: { command = "firewall-cmd"; args = [ ]; options = [ ("--add-port", "443/tcp") ], subs: [
        { command = "subcommand"; args = [ "a" ]; options = [ ] },
        { command = "subcommand"; args = [ "b" ]; options = [ ] },
 ] }
*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandParser = void 0;
/** All ASCII chars on an ANSI keyboard, less three quote-like '"`, braces {}, and backslash \ */
const NONQUOTED_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890~!@#$%^&*()-_=+[]|;:,<.>/?";
const LineBreak = 1, Quoted = 2, Unquoted = 3, AndAnd = 4, Backslash = 5, And = 6, OpenBrace = 7, CloseBrace = 8;
class CommandParser {
    static parse(str) {
        const tokens1 = tokenize_pass1(str);
        if (tokens1 instanceof Error) {
            return tokens1;
        }
        const split = splitcmd(tokens1);
        if (split instanceof Error) {
            return split;
        }
        const coll = [];
        for (const line of split.toks) {
            const parsed = parse_one(line);
            if (parsed instanceof Error) {
                return parsed;
            }
            if (parsed === undefined) {
                continue;
            }
            coll.push(parsed);
        }
        return coll;
    }
    static parse_one(str) {
        const parsed = CommandParser.parse(str);
        if (parsed instanceof Error) {
            return parsed;
        }
        if (parsed.length !== 1) {
            return new Error("Expected 1 command, got " + parsed.length);
        }
        return parsed[0];
    }
    static encode(parsed, encode_rn = true, fancy = true) { return encode(parsed, encode_rn, fancy); }
    static encode_string(string, encode_rn = true) { return autoencode(string, encode_rn); }
    static escape_template(templates, ...inserts) { return escape_template(templates, ...inserts); }
    static escape_template_rn(templates, ...inserts) { return escape_template_rn(templates, ...inserts); }
}
exports.CommandParser = CommandParser;
function splitcmd(ts, i = 0, depth = 0) {
    const separated_commands = [[]];
    while (true) {
        const token = ts[i];
        if (token === LineBreak) {
            separated_commands.push([]);
        } // LineBreaks signifies a new command will start
        else if (token === AndAnd) {
            separated_commands.push([]);
        } // AndAnd signifies a new command will start 
        else if (token === Backslash) {
            return new Error("Unexpected standalone token Backslash");
        } // Standalone backslash means it needs to but failed to cancel out a following linebreak during lexing
        else if (token === And) {
            return new Error("Unexpected standalone token And");
        } // Standalone and means it failed to cancel out a preceding linebreak during lexing
        else if (token === OpenBrace) {
            const grouped_subs = splitcmd(ts, i + 1, depth + 1);
            if (grouped_subs instanceof Error) {
                return grouped_subs;
            }
            separated_commands[separated_commands.length - 1].push(grouped_subs.toks);
            i = grouped_subs.new_i;
        }
        else if (token === CloseBrace && depth > 0) {
            return { toks: separated_commands.filter(a => a.length > 0), new_i: i };
        }
        else if (token === CloseBrace) {
            return new Error("Unmatched CloseBrace");
        }
        else if (token === undefined && depth === 0) {
            return { toks: separated_commands.filter(a => a.length > 0), new_i: i };
        }
        else if (token === undefined) {
            return new Error("Unclosed OpenBrace");
        }
        else {
            separated_commands[separated_commands.length - 1].push(token);
        }
        i += 1;
    }
}
function tokenize_pass1(str) {
    const coll = [];
    let term_cannot_start_at = -1;
    for (let i = 0; i < str.length;) {
        if (str[i] === "\n") {
            coll.push(LineBreak);
            process_linebreak_escapes(coll);
            i += 1;
        }
        else if (str[i] === "\r" && str[i + 1] === "\n") {
            coll.push(LineBreak);
            process_linebreak_escapes(coll);
            i += 2;
        }
        else if (str[i] === "\\") {
            coll.push(Backslash);
            process_linebreak_escapes(coll);
            i += 1;
        }
        else if (str[i] === "\r") {
            return new Error(`Unexpected standalone \\r at(${i})`);
        }
        else if (" \t".includes(str[i])) { // ignore white space
            i += 1;
        }
        else if (str[i] === "{") {
            coll.push(OpenBrace);
            i += 1;
        }
        else if (str[i] === "}") {
            coll.push(CloseBrace);
            i += 1;
        }
        else if ("\"'`".includes(str[i])) {
            if (i === term_cannot_start_at) {
                return new Error(`Back-to-back quoted strings at(${i})`);
            }
            const t = consume_quoted(str, i);
            if (t instanceof Error) {
                return t;
            }
            const [str_val, new_i] = t;
            i = new_i;
            term_cannot_start_at = i;
            coll.push({ t: Quoted, v: str_val });
        }
        else if (NONQUOTED_CHARS.includes(str[i])) {
            if (i === term_cannot_start_at) {
                return new Error(`Back-to-back quoted string then unquoted term at(${i})`);
            }
            const t = consume_nonquoted(str, i);
            if (t instanceof Error) {
                return t;
            }
            const [string_val, new_i] = t;
            i = new_i;
            term_cannot_start_at = i;
            if (string_val === "&&") {
                coll.push(AndAnd);
            }
            else if (string_val === "&") {
                coll.push(And);
                process_linebreak_escapes(coll);
            }
            else {
                coll.push({ t: Unquoted, v: string_val });
            }
        }
        else {
            return new Error(`Unexpected char at(${i})`);
        }
    }
    return coll;
}
function process_linebreak_escapes(tokens) {
    if (tokens.length < 2) {
        return;
    }
    const last = tokens.length - 1;
    const sndlst = tokens.length - 2;
    if (tokens[sndlst] === Backslash && tokens[last] === LineBreak) {
        tokens.pop();
        tokens.pop();
    }
    else if (tokens[sndlst] === LineBreak && tokens[last] === And) {
        tokens.pop();
        tokens.pop();
    }
}
function consume_quoted(src, pos) {
    const delim = src[pos];
    let i = pos + 1;
    let delimlen = 1;
    while (src[i] === delim) {
        i += 1;
        delimlen += 1;
    }
    let coll = "";
    if (delimlen === 2) {
        return [coll, i];
    }
    while (true) {
        if (src[i] === delim) {
            let delimlenend = 0;
            for (let j = 0; j < delimlen; j++) {
                if (src[i + j] === delim) {
                    delimlenend += 1;
                }
                else {
                    break;
                }
                if (delimlenend === delimlen) {
                    break;
                }
            }
            if (delimlenend === delimlen) {
                i += delimlen;
                return [coll, i];
            }
            else {
                i += delimlenend;
                coll += delim.repeat(delimlenend);
            }
        }
        else if (src[i] === "\\") {
            if (src[i + 1] === "t") {
                coll += "\t";
            }
            else if (src[i + 1] === "n") {
                coll += "\n";
            }
            else if (src[i + 1] === "r") {
                coll += "\r";
            }
            else if (src[i + 1] === "`") {
                coll += "`";
            }
            else if (src[i + 1] === "'") {
                coll += "'";
            }
            else if (src[i + 1] === "\"") {
                coll += "\"";
            }
            else if (src[i + 1] === "\\") {
                coll += "\\";
            }
            else {
                return new Error(`Unexpected escape sequence at(${i + 1})`);
            }
            i += 2;
        }
        else if (src[i] === undefined) {
            return new Error("Unexpected EOF");
        }
        else {
            coll += src[i];
            i += 1;
        }
    }
}
function consume_nonquoted(src, pos) {
    let i = pos + 1, coll = src[pos];
    while (src[i] !== undefined && NONQUOTED_CHARS.includes(src[i])) {
        coll += src[i];
        i += 1;
    }
    if (src[i] !== undefined && "\"\'\`".includes(src[i])) {
        const t = consume_quoted(src, i);
        if (t instanceof Error) {
            return t;
        }
        const [str_val, new_i] = t;
        return [coll + str_val, new_i];
    }
    return [coll, i];
}
function parse_one(tokens) {
    if (tokens[0] === undefined) {
        return undefined;
    }
    if (tokens[0] instanceof Array) {
        return new Error("Found subcommand array without outer command");
    }
    const parsed_command = { command: tokens[0].v, args: [], options: [], subs: [] };
    let positional_mode = false;
    for (let i = 1; i < tokens.length;) {
        const cur_tok = tokens[i];
        const next_tok = tokens[i + 1];
        if (cur_tok instanceof Array) {
            for (const line of cur_tok) {
                const parsed = parse_one(line);
                if (parsed instanceof Error) {
                    return parsed;
                }
                if (parsed) {
                    parsed_command.subs.push(parsed);
                }
            }
            if (next_tok) {
                return new Error("Extra tokens after subcommand block without linebreak or AndAnd");
            }
            i += 1;
        }
        else if (positional_mode) { // in positional mode, quoted and non quoted tokens regardless of start character goes into positional queue.
            parsed_command.args.push(cur_tok.v);
            i += 1;
        }
        else if (cur_tok.t === Quoted) { // quoted is always positional
            parsed_command.args.push(cur_tok.v);
            i += 1;
            // tokens[i] will always be unquoted from here onwards
        }
        else if (cur_tok.v === "--") { // unquoted term `--` starts positional mode
            positional_mode = true;
            i += 1;
        }
        else if (cur_tok.v[0] === "-" && next_tok !== undefined && !(next_tok instanceof Array) && (next_tok.t === Quoted || next_tok.v[0] !== "-")) {
            parsed_command.options.push([cur_tok.v, next_tok.v]);
            i += 2;
        }
        else if (cur_tok.v[0] === "-") {
            parsed_command.options.push([cur_tok.v, null]);
            i += 1;
        }
        else { // nonquoted positional
            parsed_command.args.push(cur_tok.v);
            i += 1;
        }
    }
    return parsed_command;
}
// --- end decoder --- begin encoder ---
function encode(parsed, encode_rn, fancy = false) {
    const positionals = " " + parsed.args.map(p => autoencode(p, encode_rn)).join(" ");
    const options = " " + parsed.options.map(([k, v]) => v === null ? autoencode_option(k, encode_rn) : autoencode_option(k, encode_rn) + " " + autoencode(v, encode_rn)).join(" ");
    const subs = parsed.subs.map(subcmd => encode(subcmd, encode_rn, fancy));
    const subs2 = parsed.subs.length === 0 ? "" : !fancy ? ` { ${subs.join(" && ")} }` : ` {\n\t${subs.map(a => a.replaceAll("\n", "\n\t")).join("\n\t")}\n}`;
    if (parsed.options.length === 0 && parsed.args.length === 0) {
        return parsed.command;
    }
    if (parsed.options.length === 0) {
        return parsed.command + positionals + subs2;
    }
    if (parsed.args.length === 0) {
        return parsed.command + options + subs2;
    }
    return parsed.command + positionals + options + subs2;
}
function is_option_noencode_needed(string) {
    return string.length > 100 ? false : nonquoted_charset_test(string);
}
function autoencode_option(str, encode_rn) {
    return is_option_noencode_needed(str) ? str
        : str.startsWith("--") ? "--" + encode_string(str.slice(2), encode_rn)
            : "-" + encode_string(str.slice(1), encode_rn);
}
function encode_string(s, encode_rn) {
    s = s.replaceAll("\\", "\\\\");
    if (encode_rn) {
        s = s.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
    }
    if (!s.includes("`")) {
        return "`" + s + "`";
    }
    if (!s.includes(`"`)) {
        return `"${s}"`;
    }
    if (!s.includes(`'`)) {
        return `'${s}'`;
    }
    const last = s.length - 1;
    const threedelim = s[0] !== `"` && s[last] !== `"` ? `"""` : (s[0] !== "'" && s[last] !== "'" ? `'''` : "```");
    s = s.replaceAll(threedelim, `${threedelim[0]}${threedelim[0]}\\${threedelim[0]}`);
    return `${threedelim}${s}${threedelim}`;
}
function is_string_noencode_needed(str) {
    return str.length !== 0 && str.length <= 50 && str[0] !== "-" && str[0] !== "&" && nonquoted_charset_test(str);
}
function autoencode(str, encode_rn) {
    return is_string_noencode_needed(str) ? str : encode_string(str, encode_rn);
}
function escape_template(templates, ...inserts) {
    let ret = "";
    for (let i = 0; i < inserts.length; i++) {
        ret += templates[i] + autoencode(String(inserts[i]), false);
    }
    return ret + templates[templates.length - 1];
}
function escape_template_rn(templates, ...inserts) {
    let ret = "";
    for (let i = 0; i < inserts.length; i++) {
        ret += templates[i] + autoencode(String(inserts[i]), true);
    }
    return ret + templates[templates.length - 1];
}
function nonquoted_charset_test(tested) {
    for (const char of tested) {
        if (!NONQUOTED_CHARS.includes(char)) {
            return false;
        }
    }
    return true;
}
