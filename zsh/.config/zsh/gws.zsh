# weekly agenda
function wa() {
  gws calendar +agenda --week --format json
}

# list files
function wd() {
  gws drive files list --params '{"q": "'\'$1\'' in parents and trashed=false", "fields": "files(id,name,mimeType,modifiedTime,size)"}' 2>&1
}
