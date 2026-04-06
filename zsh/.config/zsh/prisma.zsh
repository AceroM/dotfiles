function pm() {
  awk -v q="$1" '
    BEGIN { IGNORECASE=1; printing=0 }
    /^(model|enum|type|view) / { printing = ($2 ~ q) }
    printing { print }
    /^}/ && printing { print ""; printing=0 }
  ' prisma/schema.prisma
}
