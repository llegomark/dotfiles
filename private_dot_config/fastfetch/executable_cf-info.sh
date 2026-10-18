#!/bin/sh
# Cloudflare WARP / DNS info for fastfetch, using the same checks as https://one.one.one.one/help/
#   cf-info.sh warp  -> WARP state + Cloudflare data center, e.g. "Connected · CEB (PH)"
#   cf-info.sh dns   -> how DNS reaches Cloudflare, e.g. "Cloudflare (DoH)"
#   cf-info.sh resolvers -> reachability of 1.1.1.1 / 1.0.0.1 and IPv6 resolvers, e.g. "4/4 reachable"

warp_status() {
  warp-cli --accept-tos status 2>/dev/null | sed -n 's/^Status update: //p'
}

case "$1" in
  warp)
    s=$(warp_status)
    trace=$(curl -s --max-time 2 https://one.one.one.one/cdn-cgi/trace)
    colo=$(printf '%s\n' "$trace" | sed -n 's/^colo=//p')
    loc=$(printf '%s\n' "$trace" | sed -n 's/^loc=//p')
    echo "${s:-Not running}${colo:+ · $colo ($loc)}"
    ;;
  dns)
    # Each <id>.<check> hostname only resolves if the query reached Cloudflare's resolver that way
    id=$(cat /proc/sys/kernel/random/uuid)
    check() {
      curl -s -f -o /dev/null --max-time 2 "https://$id.$1.help.every1dns.net/cdn-cgi/trace" && echo "$1"
    }
    r=$(check is-cf & check is-doh & check is-dot & wait)
    case "$r" in
      *is-doh*) echo "Cloudflare (DoH)" ;;
      *is-dot*) echo "Cloudflare (DoT)" ;;
      *is-cf*)  [ "$(warp_status)" = Connected ] && echo "Cloudflare (over WARP)" || echo "Cloudflare (plain)" ;;
      *)        curl -s -o /dev/null --max-time 2 https://one.one.one.one/cdn-cgi/trace && echo "Not Cloudflare" || echo "No connection" ;;
    esac
    ;;
  resolvers)
    # Reachability of Cloudflare's resolver IPs; lists any that fail
    reach() {
      curl -s -f -o /dev/null --max-time 2 "https://$2/cdn-cgi/trace" || echo "$1"
    }
    down=$(reach 1.1.1.1 1.1.1.1 & reach 1.0.0.1 1.0.0.1 &
           reach 2606:4700:4700::1111 '[2606:4700:4700::1111]' &
           reach 2606:4700:4700::1001 '[2606:4700:4700::1001]' & wait)
    n=$(printf '%s' "$down" | grep -c .)
    echo "$((4 - n))/4 reachable${down:+ (failed: $(echo $down | sed 's/ /, /g'))}"
    ;;
esac
