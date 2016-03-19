'use strict'

var mongoose = require('mongoose');
var async = require('async')
var util = require('util')

var getArgsWithOptions = function(__fill){
  var args = [],
    options = __fill.fill.options

  var opts = __fill.opts && __fill.opts.length
    ? __fill.opts
    : options

  if (opts && opts.length){

    // add lacking or remove excessive options
    if (options){
      var diff = opts.length - options.length
      if (diff < 0){
        opts = opts.concat(options.slice(diff))
      } else if (diff > 0){
        opts = opts.slice(0, diff)
      }
    }
    args.push.apply(args, opts)
  }
  return args
}

var fillDoc = function(doc, __fill, cb){

  var args = getArgsWithOptions(__fill)

  if (__fill.fill.fill){
    args.unshift(doc)
    args.push(cb)
    __fill.fill.fill.apply(__fill.fill, args)
  } else if (__fill.fill.value) {
    var props = __fill.props,
      prop = props.length == 1 && props[0]

    var multipleProps = __fill.fill.props.length > 1

    //args.unshift(doc)
    args.push(function(err, val){
      // if val is not passed, just leave it
      if (arguments.length > 1 && val !== doc){
        if (prop){
          doc[prop] = multipleProps ? val[prop] : val
        } else {
          props.forEach(function(prop){
            doc[prop] = val[prop]
          })
        }
      }

      cb(err, doc)
    })
    __fill.fill.value.apply(doc, args)
  } else {
    cb(null, doc)
  }
}

var addFills = function(__fills, Model, props, opts){
  var added = false
  props = (typeof props == 'string') ? props.split(' ') : props
  props.forEach((prop) => {
    prop = prop.trim()
    var fill = Model.__fill[prop]
    if (!fill){
      var propSplit = prop.split('.').filter(_ => _)
      if (propSplit.length > 1){
        // filter if already added
        if (__fills.filter(__fill => __fill.fill.prop == prop).length > 0){
          return
        }
        propSplit.slice(0, propSplit.length -1)
          .forEach((prop, i) => {
            addFills(
              __fills,
              Model,
              [propSplit.slice(0, i + 1).join('.')]
            )
          })
        var fieldProp = propSplit.shift()
        fill = {
          prop: prop,
          fill: function ()  {
            var opts = Array.prototype.slice.call(arguments);
            var doc = opts.shift()
            var callback = opts.pop()
            if (doc[fieldProp]){
              var docs = doc[fieldProp]
              if (!Array.isArray(docs)){
                docs = [docs]
              }
              async.map(docs, (doc, cb) => {
                var args = [propSplit.join('.')]
                  .concat(opts || []).concat([cb])
                doc && typeof doc.fill === 'function'
                  ? doc.fill.apply(doc, args)
                  : cb()
              }, (err) => {
                callback(err, doc)
              })
            } else {
              callback(null, doc)
            }
          }
        }
      } else {
        throw new Error('fill for property "' + prop + '" not found')
      }
    }

    added = true
    fill.db = Model.db
    if (fill){
      // check if fill already added
      var __fill = __fills.filter(function(__f){return __f.fill == fill})[0]
      if (__fill){
        if (__fill.props.indexOf(prop) < 0){
          __fill.props.push(prop)
        }
      } else {
        __fills.push({fill: fill, opts: opts, props: [prop]})
      }
    }
  })
  return added
}

var _exec = mongoose.Query.prototype.exec

mongoose.Query.prototype.exec = function (op, cb) {
  var __fills = this.__fills || [];
  //console.log('query exec', this.options, 'this._conditions', this._conditions, this._fields)
  var __fillsSequence = this.__fillsSequence || []
  var query = this

  if (query.model.__fill && this._fields){
    Object.keys(this._fields).forEach(function(f){
      if (query._fields[f] == 1 && query.model.__fill[f]){
        addFills(__fills, query.model, f)
      }
    })
    __fillsSequence.unshift(__fills)
  }

  if (!__fillsSequence.length) {
    return _exec.apply(this, arguments);
  }

  var promise = new mongoose.Promise();

  if (typeof op === 'function') {
    cb = op;
    op = null;
  }

  if (cb) {
    promise.onResolve(cb);
  }
  
  _exec.call(this, op, function (err, docs) {

    if (err || !docs) {
      promise.resolve(err, docs);
    } else {

      async.mapSeries(__fillsSequence, function(__fills, cb){

        async.map(__fills, function(__fill, cb){
          var useMultiWithSingle = !util.isArray(docs) && !__fill.fill.value && __fill.fill.multi

          if (useMultiWithSingle){
            docs = [docs]
          }

          // TODO: make this also if there is only multi methods when one doc
          if (util.isArray(docs)){
            var args = getArgsWithOptions(__fill)

            if (__fill.fill.multi && !__fill.fillEach){

              var index = {},
                ids = docs.map(function(doc){
                  var id = doc._id.toString()
                  index[id] = doc
                  return doc._id
                }, {})
              args.unshift(docs, ids)

              var multipleProps = __fill.fill.props.length > 1

              // set default values
              if (__fill.fill.default){

                __fill.fill.props.forEach(function(prop, i){
                  var defaultPropValue =
                    multipleProps && Array.isArray(__fill.fill.default)
                      ? __fill.fill.default[i]
                      : __fill.fill.default
                    docs.forEach(function(doc){
                      //  ensure unique values of passed objects/arrays
                      if (typeof defaultPropValue == 'object'){
                        doc[prop] = Object.assign(
                          Array.isArray(defaultPropValue) ? [] : {}
                          , defaultPropValue)
                      } else if (typeof defaultPropValue == 'function'){
                        doc[prop] = defaultPropValue()
                      } else {
                        doc[prop] = defaultPropValue
                      }
                    })
                })
              }

              args.push(function(err, results){

                if (results && results !== docs){

                  // convert object map to array in right order
                  if (!util.isArray(results)){
                    results = ids.map(function(id){
                      return results[id]
                    })
                  }

                  results.forEach(function(r, i){
                    if (!r){
                      return
                    }
                    var doc = docs[i]

                    var spreadProps = multipleProps

                    // this is not the best idea, but we will allow this
                    if (r._id && index[r._id.toString()]){
                      spreadProps = true
                      doc = index[r._id.toString()]
                    }

                    if (!doc){return}

                    if (spreadProps){
                      __fill.props.forEach(function(prop){
                        doc[prop] = r[prop]
                      })
                    } else {
                      var prop = __fill.fill.props[0]
                      doc[prop] = r
                    }
                  })
                }
                //console.log('mongoose fill multi done', docs)
                if (useMultiWithSingle){
                  cb(err, docs[0])
                } else {
                  cb(err, docs)
                }
              })

              __fill.fill.multi.apply(__fill.fill, args)

            } else {
              async.map(docs, function(doc, cb){
                fillDoc(doc, __fill, cb)
              }, cb)
            }
          } else {
            fillDoc(docs, __fill, cb)
          }
        }, function(err){
          cb(err)
        })
      }, function(err){
        promise.resolve(err, docs);
      })
    }
  });

  return promise;
}

mongoose.Schema.prototype.fill = function(props, def) {

  this.statics.__fill = this.statics.__fill || {}

  // return
  if (this.statics.__fill[props]){
    return this.statics.__fill[props]
  }

  def = def || {}

  if (typeof def == 'function') {
    def = {value: def}
  }

  var self = this

  props = props.split(' ')

  def.props = props

  props.forEach(function (prop) {
    self.statics.__fill[prop] = def

    self.virtual(prop).get(function () {
      return this['__' + prop]
    }).set(function (val) {
      this['__' + prop] = val
    })
  })

  var defFiller = [
    'value', 'multi',
    'query', 'debug', 'default', 'options']
    .reduce(function(defFiller, method){
      if (method == 'options'){
        defFiller[method] = function(){
          def[method] = Array.prototype.slice.call(arguments);
          return defFiller
        }
      } else {
        defFiller[method] = function(val){
          def[method] = val
          return defFiller
        }
      }

      return defFiller
    }, {})

  defFiller.get = defFiller.value

  return defFiller
}


mongoose.Query.prototype.fill = function() {

  var query = this;
  var Model = this.model;

  var args = Array.prototype.slice.call(arguments);
  var props = args.shift()
  var opts = args

  query.__fillsSequence = query.__fillsSequence || []

  query.__fills = query.__fills || []
  addFills(query.__fills, Model, props, opts)

  var __fills = []
  addFills(__fills, Model, props, opts)

  query.__fillsSequence.push(__fills)

  return this
}

// force single fill
mongoose.Query.prototype.fillEach = function() {

  var prevLen = this.__fills ? query.__fills.length : 0

  this.fill.apply(this, arguments)

  for (var i = this.__fills.length - 1; i >= prevLen; i-- ){
    this.__fills[i].fillEach = true
  }

  return this
}

mongoose.Model.prototype.fill = function() {

  var doc = this;
  var Model = this.constructor;

  var args = Array.prototype.slice.call(arguments);
  var props = args.shift()
  var cb = typeof args[args.length - 1] == 'function' && args.pop()
  var opts = args

  var __fills = []
  addFills(__fills, Model, props, opts)

  async.map(__fills, function(__fill, cb){
    fillDoc(doc, __fill, cb)
  }, function(err){
    cb && cb(err, doc)
  })

  return this
}


mongoose.Model.prototype.filled = function(){

  var args = Array.prototype.slice.call(arguments);
  var cb = args[args.length - 1]
  if (typeof cb == 'function'){
    args[args.length - 1] = function(err, doc){
      cb(err, doc[prop])
    }
  }

  this.fill.apply(this, args)
}

module.exports = mongoose