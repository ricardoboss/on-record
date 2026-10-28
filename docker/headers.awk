# Translate the global section of Vite's Cloudflare _headers output to NGINX.
# Asset caching is configured by nginx.conf, separately from these security headers.
{ sub(/\r$/, "") }
/^[^ \t]/ { global = ($0 == "/*"); next }
global && /^[ \t]+[A-Za-z0-9-]+:/ {
    line = $0
    sub(/^[ \t]+/, "", line)
    separator = index(line, ":")
    name = substr(line, 1, separator - 1)
    value = substr(line, separator + 1)
    sub(/^[ \t]+/, "", value)
    printf "add_header %s \"", name
    for (i = 1; i <= length(value); i++) {
        character = substr(value, i, 1)
        if (character == "\\" || character == "\"" || character == "$") printf "\\"
        printf "%s", character
    }
    print "\" always;"
    headers++
}
END {
    if (!headers) {
        print "No global headers found in dist/_headers; run npm run build before docker build." > "/dev/stderr"
        exit 1
    }
}
